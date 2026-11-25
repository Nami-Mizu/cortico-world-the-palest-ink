/**
 * 嵌入客户端：两种协议（OpenAI 兼容 / Ollama）、限流、退避重试、批量。
 *
 * 刻意不依赖宿主也不依赖具体 SDK：`fetch` / `sleep` 都能注入，测试里不用真网络。
 * 失败一律抛 `EmbeddingError`，由上层决定「退回字面检索」还是「回失败回执」。
 *
 * 限流三件套（都在这里，不散到调用点）：
 * - 每分钟请求数：按 `60000 / rpm` 给每个请求排队，绝不并发出超过配额的请求；
 * - 并发数：信号量，本地小模型建议 1；
 * - 每日预算：由上层传入 `budget.remaining()` / `budget.record()`，用超直接抛 budget 错。
 */

import type { EmbedProtocol } from './config.ts';

export type EmbeddingErrorKind = 'config' | 'budget' | 'network' | 'timeout' | 'http' | 'shape';

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly status: number | undefined;

  constructor(kind: EmbeddingErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.status = status;
  }
}

export interface EmbeddingSettings {
  protocol: EmbedProtocol;
  baseUrl: string;
  model: string;
  /** 0 = 跟随模型。 */
  dimensions: number;
  apiKey: string;
  timeoutMs: number;
  batchSize: number;
  requestsPerMinute: number;
  concurrency: number;
  maxRetries: number;
}

/** 只用到 Response 的这几个成员，方便测试塞桩。 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<HttpResponseLike>;

export interface EmbeddingBudget {
  remaining(): number;
  record(ok: boolean, error?: string): void;
}

export interface EmbeddingClientOptions {
  settings: EmbeddingSettings;
  /** 注入点：测试用。 */
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budget?: EmbeddingBudget;
}

export interface EmbedResult {
  vectors: number[][];
  /** 实际发出的 HTTP 请求数（含重试）。 */
  calls: number;
}

const MAX_RETRY_AFTER_MS = 30_000;
const BACKOFF_BASE_MS = 400;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 别让测试进程被这个计时器吊住。
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref(): void }).unref();
  });
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 429 / 5xx / 网络错都值得重试；4xx（除 429）不重试。 */
function retryable(error: EmbeddingError): boolean {
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  if (error.kind === 'http' && error.status !== undefined) return error.status === 429 || error.status >= 500;
  return false;
}

export class EmbeddingClient {
  private readonly settings: EmbeddingSettings;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly budget: EmbeddingBudget | undefined;
  private nextSlotAt = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** 统计，给面板看。 */
  calls = 0;
  failures = 0;
  lastError: string | undefined;
  lastLatencyMs = 0;

  constructor(opts: EmbeddingClientOptions) {
    this.settings = opts.settings;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.budget = opts.budget;
  }

  /** 只发一条探针，返回维度与耗时；配置不对就抛 EmbeddingError。 */
  async probe(): Promise<{ dims: number; ms: number }> {
    const started = this.now();
    const { vectors } = await this.embed(['淡墨探针'], { maxRetries: 0 });
    const first = vectors[0];
    if (!first || !first.length) throw new EmbeddingError('shape', '接口返回了空向量。');
    return { dims: first.length, ms: Math.max(0, this.now() - started) };
  }

  async embed(texts: readonly string[], opts?: { maxRetries?: number }): Promise<EmbedResult> {
    const cleaned = texts.map((text) => text.trim());
    if (!cleaned.length) return { vectors: [], calls: 0 };
    if (cleaned.some((text) => !text)) throw new EmbeddingError('config', '要嵌入的文本里有空串。');
    this.validate();

    const batchSize = Math.max(1, Math.min(64, Math.round(this.settings.batchSize)));
    const chunks: string[][] = [];
    for (let index = 0; index < cleaned.length; index += batchSize) {
      chunks.push(cleaned.slice(index, index + batchSize));
    }

    const out: number[][] = new Array(cleaned.length);
    let cursor = 0;
    const starts = chunks.map((chunk) => {
      const start = cursor;
      cursor += chunk.length;
      return start;
    });

    let calls = 0;
    await this.mapLimit(chunks, Math.max(1, Math.min(8, Math.round(this.settings.concurrency))), async (chunk, index) => {
      const result = await this.callWithRetry(chunk, opts?.maxRetries);
      calls += result.calls;
      const start = starts[index] ?? 0;
      result.vectors.forEach((vector, offset) => {
        out[start + offset] = vector;
      });
    });

    if (out.some((vector) => !vector || !vector.length)) throw new EmbeddingError('shape', '接口返回的向量条数与请求不一致。');
    const dims = out[0]?.length ?? 0;
    for (const vector of out) {
      if (vector.length !== dims) throw new EmbeddingError('shape', `接口返回的维度不一致（${dims} 与 ${vector.length}）。`);
    }
    if (this.settings.dimensions > 0 && dims !== this.settings.dimensions) {
      throw new EmbeddingError('shape', `配置的维度是 ${this.settings.dimensions}，模型返回 ${dims}。改配置或把维度设成 0。`);
    }
    this.calls += calls;
    return { vectors: out, calls };
  }

  private validate(): void {
    if (!this.settings.baseUrl.trim()) throw new EmbeddingError('config', '没有填嵌入接口地址。');
    if (!/^https?:\/\//i.test(this.settings.baseUrl.trim())) throw new EmbeddingError('config', '嵌入接口地址要以 http:// 或 https:// 开头。');
    if (!this.settings.model.trim()) throw new EmbeddingError('config', '没有填嵌入模型名。');
    if (this.settings.protocol === 'openai' && !this.settings.apiKey.trim() && this.needsKey()) {
      throw new EmbeddingError('config', '这个接口需要密钥：先在向导里填 API 密钥（本地模型可以留空）。');
    }
  }

  /** OpenAI 官方与多数云服务要密钥；本地回环地址不强制。 */
  private needsKey(): boolean {
    try {
      const host = new URL(this.settings.baseUrl).hostname;
      return !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
    } catch {
      return true;
    }
  }

  private async callWithRetry(chunk: readonly string[], maxRetries?: number): Promise<EmbedResult> {
    const retries = Math.max(0, Math.min(5, Math.round(maxRetries ?? this.settings.maxRetries)));
    let calls = 0;
    let last: EmbeddingError | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (this.budget && this.budget.remaining() <= 0) {
        throw new EmbeddingError('budget', '今日嵌入请求已达预算上限。');
      }
      await this.acquire();
      calls += 1;
      let vectors: number[][] | null = null;
      let failure: EmbeddingError | null = null;
      try {
        const started = this.now();
        vectors = await this.request(chunk);
        this.lastLatencyMs = Math.max(0, this.now() - started);
      } catch (error) {
        failure =
          error instanceof EmbeddingError
            ? error
            : new EmbeddingError('network', error instanceof Error ? error.message : String(error));
      } finally {
        this.release();
      }

      if (vectors) {
        this.budget?.record(true);
        this.lastError = undefined;
        return { vectors, calls };
      }

      const failed = failure ?? new EmbeddingError('network', '嵌入请求失败。');
      this.failures += 1;
      this.lastError = failed.message;
      if (failed.kind !== 'budget') this.budget?.record(false, failed.message);
      last = failed;
      if (attempt >= retries || !retryable(failed)) break;
      const wait =
        failed.kind === 'http' && failed.status === 429 ? this.retryAfterMs(failed) : this.backoffMs(attempt);
      await this.sleep(wait);
    }
    throw last ?? new EmbeddingError('network', '嵌入请求失败。');
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(MAX_RETRY_AFTER_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.round(base * (0.6 + Math.random() * 0.6));
  }

  private retryAfterMs(error: EmbeddingError): number {
    const hint = (error as EmbeddingError & { retryAfterMs?: number }).retryAfterMs;
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(BACKOFF_BASE_MS, hint ?? BACKOFF_BASE_MS * 4));
  }

  /**
   * 排队：先抢并发名额，再等每分钟配额里的槽位。
   * 拿到名额后必须由调用方 `release()` 归还（放在 finally 里）。
   */
  private async acquire(): Promise<void> {
    const limit = Math.max(1, Math.min(8, Math.round(this.settings.concurrency)));
    if (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;

    const rpm = Math.max(1, Math.round(this.settings.requestsPerMinute));
    const interval = Math.max(10, Math.floor(60_000 / rpm));
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + interval;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  private async request(chunk: readonly string[]): Promise<number[][]> {
    const base = stripSlash(this.settings.baseUrl.trim());
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.settings.apiKey.trim()) headers.authorization = `Bearer ${this.settings.apiKey.trim()}`;

    const isOpenAi = this.settings.protocol === 'openai';
    const url = isOpenAi ? `${base}/embeddings` : `${base}/api/embed`;
    const body = isOpenAi
      ? {
          model: this.settings.model.trim(),
          input: [...chunk],
          ...(this.settings.dimensions > 0 ? { dimensions: this.settings.dimensions } : {}),
        }
      : { model: this.settings.model.trim(), input: [...chunk] };

    let response: HttpResponseLike;
    try {
      response = await this.withTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError('network', error instanceof Error ? error.message : String(error));
    }

    if (!response.ok && !isOpenAi && response.status === 404) {
      // 老版本 Ollama 只有逐条的 /api/embeddings。
      return this.requestOllamaLegacy(base, chunk, headers);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = text.trim().slice(0, 200);
      const error = new EmbeddingError(
        'http',
        `嵌入接口返回 ${response.status}${detail ? `：${detail}` : ''}`,
        response.status,
      );
      const retryAfter = Number(response.headers?.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        (error as EmbeddingError & { retryAfterMs?: number }).retryAfterMs = retryAfter * 1000;
      }
      throw error;
    }

    const payload = await this.parseJson(response);
    if (isOpenAi) {
      const data = (payload as { data?: Array<{ embedding?: unknown; index?: number }> }).data;
      if (!Array.isArray(data) || !data.length) throw new EmbeddingError('shape', '接口没有返回 data[].embedding。');
      const ordered = data
        .slice()
        .sort((a, b) => (Number.isFinite(a.index) ? (a.index as number) : 0) - (Number.isFinite(b.index) ? (b.index as number) : 0));
      return ordered.map((item) => this.toVector(item.embedding));
    }
    const embeddings = (payload as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings) || !embeddings.length) throw new EmbeddingError('shape', '接口没有返回 embeddings。');
    return embeddings.map((item) => this.toVector(item));
  }

  private async requestOllamaLegacy(base: string, chunk: readonly string[], headers: Record<string, string>): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of chunk) {
      const response = await this.withTimeout(`${base}/api/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.settings.model.trim(), prompt: text }),
      });
      if (!response.ok) throw new EmbeddingError('http', `嵌入接口返回 ${response.status}`, response.status);
      const payload = await this.parseJson(response);
      vectors.push(this.toVector((payload as { embedding?: unknown }).embedding));
    }
    return vectors;
  }

  private toVector(value: unknown): number[] {
    if (!Array.isArray(value) || !value.length) throw new EmbeddingError('shape', '向量为空或不是数组。');
    return value.map((item) => {
      const number = typeof item === 'number' ? item : Number(item);
      if (!Number.isFinite(number)) throw new EmbeddingError('shape', '向量里混进了非数字。');
      return number;
    });
  }

  private async parseJson(response: HttpResponseLike): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new EmbeddingError('shape', `接口返回的不是 JSON：${text.trim().slice(0, 120)}`);
    }
  }

  private async withTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<HttpResponseLike> {
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Math.round(this.settings.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new EmbeddingError('timeout', `嵌入请求超过 ${timeoutMs}ms 没有响应。`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 小信号量；不引依赖。 */
  private async mapLimit<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
    let index = 0;
    const runners: Promise<void>[] = [];
    for (let slot = 0; slot < Math.min(limit, items.length); slot += 1) {
      runners.push(
        (async () => {
          for (;;) {
            const current = index;
            index += 1;
            const item = items[current];
            if (current >= items.length || item === undefined) return;
            await worker(item, current);
          }
        })(),
      );
    }
    await Promise.all(runners);
  }
}
