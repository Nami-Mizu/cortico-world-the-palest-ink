import { describe, expect, it } from 'vitest';
import {
  EmbeddingClient,
  EmbeddingError,
  type EmbeddingSettings,
  type FetchLike,
  type HttpResponseLike,
} from '../src/embedding.ts';

function settings(overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings {
  return {
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-embed',
    dimensions: 0,
    apiKey: 'sk-test',
    timeoutMs: 1000,
    batchSize: 2,
    requestsPerMinute: 6000,
    concurrency: 1,
    maxRetries: 2,
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

interface Call {
  url: string;
  body: { input?: string[]; model?: string; prompt?: string; dimensions?: number };
}

/** 按请求体里的 input 顺序生成向量，方便断言「批次、顺序、维度」。 */
function vectorFor(text: string): number[] {
  return [text.length, 1, 0];
}

function recording(handler: (call: Call, index: number) => HttpResponseLike | Promise<HttpResponseLike>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, body: JSON.parse(init.body) as Call['body'] };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

describe('EmbeddingClient：OpenAI 协议', () => {
  it('按 batchSize 分批，响应里 index 乱序也能对上', async () => {
    const { fetchImpl, calls } = recording((call) => {
      const input = call.body.input ?? [];
      // 故意反着返回，验证排序。
      const data = input.map((text, index) => ({ index, embedding: vectorFor(text) })).reverse();
      return response(200, { data });
    });
    const client = new EmbeddingClient({ settings: settings({ batchSize: 2 }), fetchImpl, sleep: async () => {} });
    const result = await client.embed(['一', '二二', '三三三']);
    expect(result.calls).toBe(2);
    expect(calls.map((call) => call.body.input)).toEqual([['一', '二二'], ['三三三']]);
    expect(result.vectors).toEqual([
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9/v1/embeddings');
    expect(calls[0]?.body.model).toBe('test-embed');
  });

  it('显式维度会写进请求体', async () => {
    const { fetchImpl, calls } = recording(() => response(200, { data: [{ index: 0, embedding: [1, 0] }] }));
    const client = new EmbeddingClient({ settings: settings({ dimensions: 2 }), fetchImpl, sleep: async () => {} });
    await client.embed(['x']);
    expect(calls[0]?.body.dimensions).toBe(2);
  });

  it('429 会按退避重试，第二次成功', async () => {
    const { fetchImpl, calls } = recording((_call, index) => {
      if (index === 0) return response(429, { error: 'slow down' }, { 'retry-after': '0.01' });
      return response(200, { data: [{ index: 0, embedding: [1, 0, 0] }] });
    });
    const waits: number[] = [];
    const client = new EmbeddingClient({
      settings: settings(),
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const result = await client.embed(['x']);
    expect(result.calls).toBe(2);
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBe(400);
  });

  it('401 不重试，直接把状态码带进错误', async () => {
    const { fetchImpl, calls } = recording(() => response(401, 'bad key'));
    const client = new EmbeddingClient({ settings: settings(), fetchImpl, sleep: async () => {} });
    await expect(client.embed(['x'])).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('重试用尽后抛出最后一次的错误', async () => {
    const { fetchImpl, calls } = recording(() => response(503, 'busy'));
    const client = new EmbeddingClient({
      settings: settings({ maxRetries: 1 }),
      fetchImpl,
      sleep: async () => {},
    });
    await expect(client.embed(['x'])).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(calls).toHaveLength(2);
  });

  it('预算用尽时一次请求都不发', async () => {
    const { fetchImpl, calls } = recording(() => response(200, { data: [] }));
    const client = new EmbeddingClient({
      settings: settings(),
      fetchImpl,
      sleep: async () => {},
      budget: { remaining: () => 0, record: () => {} },
    });
    await expect(client.embed(['x'])).rejects.toMatchObject({ kind: 'budget' });
    expect(calls).toHaveLength(0);
  });

  it('维度与配置不符时报 shape 错，不把脏向量写进去', async () => {
    const { fetchImpl } = recording(() => response(200, { data: [{ index: 0, embedding: [1, 0, 0] }] }));
    const client = new EmbeddingClient({ settings: settings({ dimensions: 8 }), fetchImpl, sleep: async () => {} });
    await expect(client.embed(['x'])).rejects.toMatchObject({ kind: 'shape' });
  });

  it('远程地址缺密钥时在发请求前就报配置错', async () => {
    const client = new EmbeddingClient({
      settings: settings({ apiKey: '', baseUrl: 'https://api.example.com/v1' }),
      fetchImpl: async () => response(200, { data: [] }),
      sleep: async () => {},
    });
    await expect(client.probe()).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('超时会被标成 timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new EmbeddingClient({ settings: settings({ timeoutMs: 500 }), fetchImpl, sleep: async () => {} });
    await expect(client.embed(['x'])).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('EmbeddingClient：Ollama 协议', () => {
  it('新版 /api/embed 一次拿整批', async () => {
    const { fetchImpl, calls } = recording((call) => {
      const input = call.body.input ?? [];
      return response(200, { embeddings: input.map(vectorFor) });
    });
    const client = new EmbeddingClient({
      settings: settings({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
      fetchImpl,
      sleep: async () => {},
    });
    const result = await client.embed(['a', 'bb']);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(result.vectors).toEqual([
      [1, 1, 0],
      [2, 1, 0],
    ]);
  });

  it('旧版不认 /api/embed（404）时逐条退 /api/embeddings', async () => {
    const { fetchImpl, calls } = recording((call) => {
      if (call.url.endsWith('/api/embed')) return response(404, 'not found');
      return response(200, { embedding: vectorFor(call.body.prompt ?? '') });
    });
    const client = new EmbeddingClient({
      settings: settings({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
      fetchImpl,
      sleep: async () => {},
    });
    const result = await client.embed(['a', 'bb']);
    expect(result.vectors).toEqual([
      [1, 1, 0],
      [2, 1, 0],
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:11434/api/embed',
      'http://127.0.0.1:11434/api/embeddings',
      'http://127.0.0.1:11434/api/embeddings',
    ]);
  });
});
