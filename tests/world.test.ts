import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { THE_PALEST_INK } from '../src/definition.ts';
import { INK_DEFAULTS, type InkConfigSection } from '../src/config.ts';
import { ThePalestInkWorld } from '../src/world.ts';
import type { FetchLike, HttpResponseLike } from '../src/embedding.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'thepalestink-world-'));
});
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

const CALL = {} as ToolCallContext;

function textOf(outcome: string | ToolOutcome): string {
  return typeof outcome === 'string' ? outcome : outcome.text;
}

function failedOf(outcome: string | ToolOutcome): boolean {
  return typeof outcome === 'object' && outcome.failed === true;
}

function tool(world: { tools(): ToolDef[] }, name: string): ToolDef {
  const found = world.tools().find((item) => item.name === name);
  if (!found) throw new Error(`没有工具 ${name}`);
  return found;
}

function idFrom(text: string): string {
  const matched = /已记下 (mem_[A-Za-z0-9]+)/.exec(text);
  if (!matched) throw new Error(`回执里没有 id：${text}`);
  return matched[1];
}

/** World.envPromptVars 在契约里允许返回 null/Promise，这里一步收敛成扁平对象。 */
async function varsOf(world: { envPromptVars(): unknown }): Promise<Record<string, string>> {
  const vars = await Promise.resolve(world.envPromptVars());
  return (vars ?? {}) as Record<string, string>;
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

/** 固定向量：所有文本都映射到同一方向，于是「语义上」永远近似。 */
function fixedVectorFetch(vector: number[]): FetchLike {
  return async (_url, init) => {
    const input = (JSON.parse(init.body) as { input?: string[] }).input ?? [];
    return jsonResponse(200, { data: input.map((_text, index) => ({ index, embedding: vector })) });
  };
}

function brokenFetch(message = 'connect ECONNREFUSED 127.0.0.1:9'): FetchLike {
  return async () => {
    throw new Error(message);
  };
}

function semanticWorld(ctx: { dataDir: string }, overrides: {
  fetchImpl: FetchLike;
  cfg?: Partial<InkConfigSection>;
  persist?: (patch: Record<string, unknown>) => void;
  storeSecret?: (name: string, value: string) => void;
}): ThePalestInkWorld {
  return new ThePalestInkWorld({
    cfg: {
      ...INK_DEFAULTS,
      semanticEnabled: true,
      embedBaseUrl: 'http://127.0.0.1:9/v1',
      embedModel: 'fake-embed',
      embedDimensions: 3,
      embedAutoReindex: false,
      ...overrides.cfg,
    },
    timezone: 'Asia/Shanghai',
    dataDir: ctx.dataDir,
    secret: () => 'sk-test',
    storeSecret: overrides.storeSecret ?? (() => {}),
    persist: overrides.persist ?? (() => {}),
    fetchImpl: overrides.fetchImpl,
  });
}

interface PanelEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

async function panel(world: { webUi?(language?: string): { invoke?(panel: string, method: string, args: unknown[]): Promise<unknown> } | undefined }, name: string, method: string, ...args: unknown[]): Promise<PanelEnvelope> {
  const decl = world.webUi?.('zh');
  const invoke = decl?.invoke;
  if (!invoke) throw new Error('这个 World 没有面板 invoke。');
  return (await invoke(name, method, args)) as PanelEnvelope;
}

async function until(probe: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > end) throw new Error('等待条件超时。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('淡墨 · 记忆库', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(THE_PALEST_INK, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('挂载时投一条 ink.memory.loaded 事件,origin 是 internal', async () => {
    const world = THE_PALEST_INK.create(fakeWorldContext(THE_PALEST_INK, { scratchDir }));
    const host = new FakeHost();
    await world.start(host);
    expect(host.events.map((e) => e.type)).toEqual(['ink.memory.loaded']);
    expect(host.events[0].origin).toBe('internal');
    await world.stop();
  });

  it('写入落盘、可检索、可修订、归档后默认检索看不到', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = THE_PALEST_INK.create(ctx);
    const host = new FakeHost();
    await world.start(host);

    const remembered = await tool(world, 'ink_remember').handler(
      { text: '对方叫林照，负责「淡墨」这个记忆库项目。', kind: 'fact', tags: ['林照', '项目'], importance: 4 },
      CALL,
    );
    const id = idFrom(textOf(remembered));
    expect(existsSync(join(ctx.dataDir, 'thepalestink', 'entries.json'))).toBe(true);

    const found = textOf(await tool(world, 'ink_search').handler({ query: '林照' }, CALL));
    expect(found).toContain(id);
    expect(found).toContain('找到 1 条');

    const full = textOf(await tool(world, 'ink_recall').handler({ id }, CALL));
    expect(full).toContain('负责「淡墨」这个记忆库项目');

    const amended = textOf(await tool(world, 'ink_amend').handler({ id, importance: 5 }, CALL));
    expect(amended).toContain('重要度 5');

    expect(textOf(await tool(world, 'ink_forget').handler({ id, reason: '记重了' }, CALL))).toContain('已归档');
    const hidden = textOf(await tool(world, 'ink_search').handler({ query: '林照' }, CALL));
    expect(hidden).toContain('没有找到');

    expect(host.events.map((e) => e.type)).toEqual([
      'ink.memory.loaded',
      'ink.memory.added',
      'ink.memory.recalled',
      'ink.memory.amended',
      'ink.memory.archived',
    ]);

    // 归档后仍能按 id 读到全文，并再记一次取用
    expect(textOf(await tool(world, 'ink_recall').handler({ id }, CALL))).toContain('林照');
    expect(host.events[host.events.length - 1].type).toBe('ink.memory.recalled');
    await world.stop();
  });

  it('purge 默认被拒，配置放开后才真删', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = THE_PALEST_INK.create(ctx);
    await world.start(new FakeHost());
    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '一条待删的记忆。' }, CALL)));

    const refused = await tool(world, 'ink_forget').handler({ id, purge: true }, CALL);
    expect(failedOf(refused)).toBe(true);
    expect(textOf(refused)).toContain('hardDeleteOnForget');

    ctx.persist({ hardDeleteOnForget: true });
    const purged = textOf(await tool(world, 'ink_forget').handler({ id, purge: true }, CALL));
    expect(purged).toContain('已删除');
    expect(textOf(await tool(world, 'ink_recall').handler({ id }, CALL))).toContain('找不到');
    await world.stop();
  });

  it('容量上限淘汰最久未取用的条目，置顶条目不淘汰', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    ctx.persist({ maxEntries: 2 });
    const world = THE_PALEST_INK.create(ctx);
    await world.start(new FakeHost());

    const pinned = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '长期设定：语气用白话。', pinned: true }, CALL)));
    const old = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '临时：今天先看框架。' }, CALL)));
    const fresh = textOf(
      await tool(world, 'ink_remember').handler({ text: '临时：明天补测试。' }, CALL),
    );
    expect(fresh).toContain('移入归档');

    const live = textOf(await tool(world, 'ink_list').handler({}, CALL));
    expect(live).toContain(pinned);
    expect(live).not.toContain(old);

    const vars = await varsOf(world);
    expect(vars['thepalestink.count']).toBe('2');
    expect(vars['thepalestink.archived']).toBe('1');
    await world.stop();
  });

  it('配置改小上限会立刻淘汰并推 evicted 事件', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = THE_PALEST_INK.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    await tool(world, 'ink_remember').handler({ text: '第一条。' }, CALL);
    await tool(world, 'ink_remember').handler({ text: '第二条。' }, CALL);
    ctx.persist({ maxEntries: 1 });
    await tool(world, 'ink_search').handler({ query: '第一条' }, CALL);
    expect(host.events.map((e) => e.type)).toContain('ink.memory.evicted');
    expect((await varsOf(world))['thepalestink.count']).toBe('1');
    await world.stop();
  });

  it('默认配置来自 INK_DEFAULTS', () => {
    expect(THE_PALEST_INK.defaults()).toEqual(INK_DEFAULTS);
    expect(INK_DEFAULTS.maxEntries).toBeGreaterThan(0);
  });
});

describe('淡墨 · 语义检索', () => {
  it('字面完全对不上时，向量近似也能把条目录回来', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = semanticWorld(ctx, { fetchImpl: fixedVectorFetch([1, 0, 0]) });
    const host = new FakeHost();
    await world.start(host);
    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '今天学了折纸：鹤与船。' }, CALL)));

    await until(async () => {
      const status = await panel(world, 'embedding', 'status');
      return status.ok && (status.data as { indexed: number }).indexed === 1;
    });

    const found = textOf(await tool(world, 'ink_search').handler({ query: '量子力学' }, CALL));
    expect(found).toContain(id);
    expect(found).toContain('含语义');

    const status = await panel(world, 'embedding', 'status');
    expect((status.data as { state: string }).state).toBe('ready');

    const hits = await panel(world, 'library', 'search', { query: '量子力学' });
    expect(hits.ok).toBe(true);
    expect((hits.data as { semantic: boolean }).semantic).toBe(true);
    const first = (hits.data as { hits: Array<{ id: string; semantic: number }> }).hits[0];
    expect(first?.id).toBe(id);
    expect(first?.semantic).toBeGreaterThan(0.9);

    expect(host.events.map((event) => event.type)).toContain('ink.embed.ready');
    await world.stop();
  });

  it('嵌入连不上时退回字面检索，并在回执里说明原因', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = semanticWorld(ctx, { fetchImpl: brokenFetch() });
    await world.start(new FakeHost());
    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '折纸课的教室在三楼。' }, CALL)));

    const found = textOf(await tool(world, 'ink_search').handler({ query: '折纸' }, CALL));
    expect(found).toContain(id);
    expect(found).toContain('语义检索这次没连上');
    expect(found).toContain('ECONNREFUSED');

    const status = await panel(world, 'embedding', 'status');
    expect((status.data as { state: string }).state).toBe('error');
    await world.stop();
  });
});

describe('淡墨 · 面板', () => {
  it('记忆库面板能看快照、检索、读单条全文', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = THE_PALEST_INK.create(ctx);
    await world.start(new FakeHost());
    const id = idFrom(
      textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责「淡墨」项目。', tags: ['林照'] }, CALL)),
    );

    const snapshot = await panel(world, 'library', 'snapshot');
    expect(snapshot.ok).toBe(true);
    const data = snapshot.data as { counts: { total: number }; recent: Array<{ id: string }>; embed: { state: string } };
    expect(data.counts.total).toBe(1);
    expect(data.recent[0]?.id).toBe(id);
    expect(data.embed.state).toBe('off');

    const hits = await panel(world, 'library', 'search', { query: '林照' });
    expect((hits.data as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id)).toEqual([id]);

    const entryResult = await panel(world, 'library', 'entry', { id });
    const entry = entryResult.data as { text: string; vectorized: boolean };
    expect(entry.text).toContain('淡墨');
    expect(entry.vectorized).toBe(false);
    await world.stop();
  });

  it('保存嵌入配置会校验范围，并写回宿主配置', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const persisted: Array<Record<string, unknown>> = [];
    const world = semanticWorld(ctx, {
      fetchImpl: fixedVectorFetch([1, 0, 0]),
      persist: (patch) => persisted.push(patch),
    });
    await world.start(new FakeHost());

    const bad = await panel(world, 'embedding', 'save', { requestsPerMinute: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('6–6000');

    const badUrl = await panel(world, 'embedding', 'save', { baseUrl: 'ftp://x' });
    expect(badUrl.ok).toBe(false);
    expect(badUrl.error).toContain('http://');

    const ok = await panel(world, 'embedding', 'save', { requestsPerMinute: 30, model: 'text-embedding-3-large' });
    expect(ok.ok).toBe(true);
    expect(persisted[0]).toMatchObject({ embedRequestsPerMinute: 30, embedModel: 'text-embedding-3-large' });
    await world.stop();
  });

  it('保存密钥交给 storeSecret，不进配置文件', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const secrets: Array<[string, string]> = [];
    const world = semanticWorld(ctx, {
      fetchImpl: fixedVectorFetch([1, 0, 0]),
      storeSecret: (name, value) => secrets.push([name, value]),
    });
    await world.start(new FakeHost());

    const empty = await panel(world, 'embedding', 'save-secret', { secret: '  ' });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('不能为空');

    const saved = await panel(world, 'embedding', 'save-secret', { secret: '  sk-abc123  ' });
    expect(saved.ok).toBe(true);
    expect(secrets).toEqual([['THEPALESTINK_EMBED_KEY', 'sk-abc123']]);
    await world.stop();
  });

  it('测试连接失败时返回失败回执，不抛异常', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = semanticWorld(ctx, { fetchImpl: brokenFetch('socket hang up') });
    await world.start(new FakeHost());

    const probe = await panel(world, 'embedding', 'probe');
    expect(probe.ok).toBe(true);
    const data = probe.data as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain('socket hang up');
    await world.stop();
  });
});

