/**
 * 向量仓：`<dataDir>/thepalestink/vectors.json`。
 *
 * 和记忆正文分开存——换模型时整仓作废重建，正文一个字都不动。
 * 文件里还记着每日调用计数（限流预算用），所以它也是「嵌入账本」。
 *
 * 不 import 宿主：`_dev/verify.mjs` 与测试都能直接构造它。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EmbedProtocol } from './config.ts';
import { nowIso } from './util.ts';

export const VECTOR_SCHEMA = 1;
/** 向量分量保留几位小数；5 位足够排序，体积只有全精度的一半。 */
const PRECISION = 5;

export interface StoredVector {
  /** 分量。 */
  v: number[];
  /** 写入时刻。 */
  at: string;
}

export interface EmbedUsage {
  /** 记账的日期，`YYYY-MM-DD`（部署时区）。跨天自动清零。 */
  day: string;
  /** 今天已发的请求数（一批算一次）。 */
  calls: number;
  /** 今天失败了几次。 */
  failures: number;
  /** 累计请求数。 */
  totalCalls: number;
  /** 最近一次成功。 */
  lastOkAt?: string;
  /** 最近一次失败的原因（一句话）。 */
  lastError?: string;
}

export interface VectorFile {
  schema: number;
  /** 向量化时用的模型名；和当前配置不一致就说明要重建。 */
  model: string;
  /** 维度；0 表示还不知道。 */
  dims: number;
  updatedAt: string;
  usage: EmbedUsage;
  vectors: Record<string, StoredVector>;
}

export interface VectorStoreOptions {
  dataDir: string;
  timezone: string;
}

function emptyUsage(day: string): EmbedUsage {
  return { day, calls: 0, failures: 0, totalCalls: 0 };
}

function round(value: number): number {
  return Math.round(value * 10 ** PRECISION) / 10 ** PRECISION;
}

export class VectorStore {
  readonly file: string;
  private readonly timezone: string;
  private state: VectorFile | null = null;
  private recoveredFrom: string | null = null;

  constructor(opts: VectorStoreOptions) {
    this.file = join(opts.dataDir, 'thepalestink', 'vectors.json');
    this.timezone = opts.timezone;
  }

  /** 上次坏档被改名到哪儿；没有就是 null。 */
  recovery(): string | null {
    return this.recoveredFrom;
  }

  model(): string {
    return this.current().model;
  }

  dims(): number {
    return this.current().dims;
  }

  count(): number {
    return Object.keys(this.current().vectors).length;
  }

  get(id: string): number[] | null {
    const hit = this.current().vectors[id];
    return hit ? hit.v : null;
  }

  usage(): EmbedUsage {
    return { ...this.current().usage };
  }

  /** 记一次请求（成功或失败），顺带把跨天的计数清零。 */
  bumpUsage(ok: boolean, error?: string): void {
    const state = this.current();
    const today = nowIso(this.timezone).slice(0, 10);
    if (state.usage.day !== today) state.usage = emptyUsage(today);
    state.usage.calls += 1;
    state.usage.totalCalls += 1;
    if (ok) {
      state.usage.lastOkAt = nowIso(this.timezone);
      state.usage.lastError = undefined;
    } else {
      state.usage.failures += 1;
      if (error) state.usage.lastError = error;
    }
    this.save();
  }

  /** 今天还能发几次；`budget` 为 0 表示不限。 */
  remainingBudget(budget: number): number {
    if (budget <= 0) return Number.POSITIVE_INFINITY;
    const state = this.current();
    const today = nowIso(this.timezone).slice(0, 10);
    const used = state.usage.day === today ? state.usage.calls : 0;
    return Math.max(0, budget - used);
  }

  put(id: string, vector: readonly number[], at: string): void {
    const state = this.current();
    const dims = vector.length;
    if (dims <= 0) throw new Error('空向量不能入库。');
    if (state.dims && state.dims !== dims) {
      throw new Error(`向量维度不一致：库里是 ${state.dims}，这次是 ${dims}。换模型后要先重建向量仓。`);
    }
    state.dims = dims;
    state.vectors[id] = { v: vector.map(round), at };
    state.updatedAt = nowIso(this.timezone);
    this.save();
  }

  remove(id: string): void {
    const state = this.current();
    if (!(id in state.vectors)) return;
    delete state.vectors[id];
    state.updatedAt = nowIso(this.timezone);
    this.save();
  }

  /** 清空向量与元信息（换模型时用），用量账本保留。 */
  reset(model: string, dims: number): void {
    const state = this.current();
    state.model = model;
    state.dims = dims;
    state.vectors = {};
    state.updatedAt = nowIso(this.timezone);
    this.save();
  }

  /** 只保留还存在的条目 id；返回删掉的条数。 */
  prune(validIds: ReadonlySet<string>): number {
    const state = this.current();
    let removed = 0;
    for (const id of Object.keys(state.vectors)) {
      if (!validIds.has(id)) {
        delete state.vectors[id];
        removed += 1;
      }
    }
    if (removed) {
      state.updatedAt = nowIso(this.timezone);
      this.save();
    }
    return removed;
  }

  /** 向量仓里哪些 id 还没有向量。 */
  missing(ids: readonly string[]): string[] {
    return ids.filter((id) => !(id in this.current().vectors));
  }

  private current(): VectorFile {
    this.ensureLoaded();
    if (!this.state) throw new Error('向量仓未能加载。');
    return this.state;
  }

  private ensureLoaded(): void {
    if (this.state) return;
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) {
      this.state = {
        schema: VECTOR_SCHEMA,
        model: '',
        dims: 0,
        updatedAt: nowIso(this.timezone),
        usage: emptyUsage(nowIso(this.timezone).slice(0, 10)),
        vectors: {},
      };
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<VectorFile>;
      const model = typeof raw.model === 'string' ? raw.model : '';
      const dims = Number.isFinite(raw.dims) ? Math.max(0, Math.round(raw.dims as number)) : 0;
      const usageRaw = raw.usage ?? emptyUsage(nowIso(this.timezone).slice(0, 10));
      this.state = {
        schema: VECTOR_SCHEMA,
        model,
        dims,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(this.timezone),
        usage: {
          day: typeof usageRaw.day === 'string' ? usageRaw.day : nowIso(this.timezone).slice(0, 10),
          calls: Number.isFinite(usageRaw.calls) ? Math.max(0, Math.round(usageRaw.calls as number)) : 0,
          failures: Number.isFinite(usageRaw.failures) ? Math.max(0, Math.round(usageRaw.failures as number)) : 0,
          totalCalls: Number.isFinite(usageRaw.totalCalls) ? Math.max(0, Math.round(usageRaw.totalCalls as number)) : 0,
          ...(typeof usageRaw.lastOkAt === 'string' ? { lastOkAt: usageRaw.lastOkAt } : {}),
          ...(typeof usageRaw.lastError === 'string' ? { lastError: usageRaw.lastError } : {}),
        },
        vectors: {},
      };
      for (const [id, item] of Object.entries(raw.vectors ?? {})) {
        const vector = (item as StoredVector | null)?.v;
        if (!Array.isArray(vector) || !vector.length || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
        this.state.vectors[id] = { v: vector, at: typeof (item as StoredVector).at === 'string' ? (item as StoredVector).at : nowIso(this.timezone) };
      }
    } catch {
      const backup = `${this.file}.broken-${Date.now().toString(36)}`;
      try {
        renameSync(this.file, backup);
        this.recoveredFrom = backup;
      } catch {
        this.recoveredFrom = null;
      }
      this.state = {
        schema: VECTOR_SCHEMA,
        model: '',
        dims: 0,
        updatedAt: nowIso(this.timezone),
        usage: emptyUsage(nowIso(this.timezone).slice(0, 10)),
        vectors: {},
      };
    }
  }

  private save(): void {
    const state = this.current();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}

/** 供面板展示：协议 + 地址 + 模型 拼成一句。 */
export function describeEmbedTarget(protocol: EmbedProtocol, baseUrl: string, model: string): string {
  return `${protocol} · ${baseUrl || '（未填地址）'} · ${model || '（未填模型）'}`;
}
