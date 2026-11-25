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
    // 默认是 quiet（自己的动作不发回声事件）；这一条用例专门验事件，切回 normal。
    ctx.cfg.eventLevel = 'normal';
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

describe('淡墨 · 提醒与自动归档', () => {
  function reminderWorld(ctx: { dataDir: string; cfg: InkConfigSection }, cfg: Partial<InkConfigSection>, at: Date): ThePalestInkWorld {
    // 复用 ctx.cfg 的引用：面板保存 / ctx.persist 要能热改到这个世界实例。
    Object.assign(ctx.cfg as object, { ...INK_DEFAULTS, ...cfg });
    return new ThePalestInkWorld({
      cfg: ctx.cfg,
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
      now: () => at,
    });
  }

  it('cron 到点推一条提醒，同一分钟只推一次', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const at = new Date('2026-11-25T23:30:00+08:00');
    const world = reminderWorld(ctx, { writeCron: '* * * * *', writeCronNote: '重点看项目约定。' }, at);
    const host = new FakeHost();
    await world.start(host);

    await world.tick(at);
    const reminders = (): number => host.events.filter((event) => event.type === 'ink.reminder.schedule').length;
    expect(reminders()).toBe(1);
    expect(host.events[host.events.length - 1].text).toContain('重点看项目约定');

    // 同一分钟不重复推
    await world.tick(at);
    expect(reminders()).toBe(1);

    // 下一分钟再推
    await world.tick(new Date(at.getTime() + 60_000));
    expect(reminders()).toBe(2);

    const snapshot = await panel(world, 'library', 'snapshot');
    const rhythm = (snapshot.data as { rhythm: { cronValid: boolean; cronNextAt: string | null; lastReminder: { kind: string } | null } }).rhythm;
    expect(rhythm.cronValid).toBe(true);
    expect(rhythm.cronNextAt).not.toBeNull();
    expect(rhythm.lastReminder?.kind).toBe('schedule');
    await world.stop();
  });

  it('cron 没到点不推；写错的 cron 在面板里给出错误', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const at = new Date('2026-11-25T23:30:00+08:00');
    const world = reminderWorld(ctx, { writeCron: '30 7 * * *' }, at);
    const host = new FakeHost();
    await world.start(host);
    await world.tick(at);
    expect(host.events.map((event) => event.type)).not.toContain('ink.reminder.schedule');

    ctx.persist({ writeCron: '99 * * * *' });
    await world.tick(new Date(at.getTime() + 60_000));
    const snapshot = await panel(world, 'library', 'snapshot');
    const rhythm = (snapshot.data as { rhythm: { cronValid: boolean; cronError: string | null } }).rhythm;
    expect(rhythm.cronValid).toBe(false);
    expect(rhythm.cronError).toContain('0–59');
    await world.stop();
  });

  it('上下文估算过阈值时提醒，冷却期内不重复', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const at = new Date('2026-11-25T23:30:00+08:00');
    const world = reminderWorld(
      ctx,
      { writeCron: '', contextReminderPercent: 10, contextReminderCooldownMinutes: 60 },
      at,
    );
    const host = new FakeHost();
    host.modelFacts = { ...host.modelFacts, contextWindow: () => 100 };
    await world.start(host);

    // 100 token 的窗口，灌 30 个汉字 ≈ 30 token → 30%
    await host.pushEvent({
      type: 'chat.message',
      ts: '2026-11-25T23:29:00+08:00',
      source: 'test',
      origin: 'external',
      senderKey: 'user',
      text: '一'.repeat(30),
    } as Parameters<FakeHost['pushEvent']>[0]);

    await world.tick(at);
    expect(host.events.map((event) => event.type)).toContain('ink.reminder.context');

    // 冷却期内不重复
    await world.tick(new Date(at.getTime() + 5 * 60_000));
    const countAfterCooldown = host.events.filter((event) => event.type === 'ink.reminder.context').length;
    expect(countAfterCooldown).toBe(1);

    // 冷却过了再提醒
    await world.tick(new Date(at.getTime() + 61 * 60_000));
    expect(host.events.filter((event) => event.type === 'ink.reminder.context').length).toBe(2);
    await world.stop();
  });

  it('交接结束后提醒补写；关掉开关就不提醒', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = new ThePalestInkWorld({
      cfg: { ...INK_DEFAULTS, handoffReminder: true },
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
    });
    const host = new FakeHost();
    await world.start(host);
    world.onHandoffEnded();
    expect(host.events.map((event) => event.type)).toContain('ink.reminder.handoff');

    const off = new ThePalestInkWorld({
      cfg: { ...INK_DEFAULTS, handoffReminder: false },
      timezone: 'Asia/Shanghai',
      dataDir: join(scratchDir, 'off'),
    });
    const quiet = new FakeHost();
    await off.start(quiet);
    off.onHandoffEnded();
    expect(quiet.events.map((event) => event.type)).not.toContain('ink.reminder.handoff');
    await world.stop();
    await off.stop();
  });

  it('过期条目：列得出、检索标已过期、整理提醒报数量、amend 能续期', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    // 时钟对象要可变：面板与 ink_expired 读的是 world.now()，不是 tick 的参数。
    const at = new Date();
    const world = reminderWorld(ctx, { writeCron: '* * * * *' }, at);
    const host = new FakeHost();
    await world.start(host);

    const receipt = textOf(await tool(world, 'ink_remember').handler({ text: '周六去旧书店取预订的书', expiresInDays: 1 }, CALL));
    expect(receipt).toContain('有效期 1 天');
    const id = idFrom(receipt);

    expect(textOf(await tool(world, 'ink_expired').handler({}, CALL))).toContain('没有过期的记忆');

    // 把时钟推到三天后：条目应过期，整理提醒里带数量。
    const later = new Date(Date.now() + 3 * 86_400_000);
    at.setTime(later.getTime());
    await world.tick(later);
    const reminders = host.events.filter((event) => event.type === 'ink.reminder.schedule');
    expect(reminders[reminders.length - 1]?.text).toContain('1 条已经过期');

    const listed = textOf(await tool(world, 'ink_expired').handler({}, CALL));
    expect(listed).toContain(id);
    expect(listed).toContain('⏳');

    // 过期但没归档：检索仍然找得到，只是要标出来。
    const found = textOf(await tool(world, 'ink_search').handler({ query: '旧书店' }, CALL));
    expect(found).toContain(id);
    expect(found).toContain('⏳ 已过期');

    const stats = textOf(await tool(world, 'ink_stats').handler({}, CALL));
    expect(stats).toContain('过期待整理：1 条');

    // 续期 30 天后就不再算过期。
    const amended = textOf(await tool(world, 'ink_amend').handler({ id, expiresInDays: 30 }, CALL));
    expect(amended).toContain('有效期 30 天');
    expect(textOf(await tool(world, 'ink_expired').handler({}, CALL))).toContain('没有过期的记忆');
    await world.stop();
  });

  it('不填 expiresInDays 的记忆永不过期', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const at = new Date();
    const world = reminderWorld(ctx, { writeCron: '' }, at);
    const host = new FakeHost();
    await world.start(host);
    await tool(world, 'ink_remember').handler({ text: '对方的生日是三月十二。' }, CALL);
    await world.tick(new Date(Date.now() + 400 * 86_400_000));
    expect(textOf(await tool(world, 'ink_expired').handler({}, CALL))).toContain('没有过期的记忆');
    await world.stop();
  });

  it('久未取用且重要度低的条目会被自动归档，置顶与重要度 5 不动', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const now = new Date('2026-11-25T12:00:00+08:00');
    const world = new ThePalestInkWorld({
      cfg: { ...INK_DEFAULTS, autoArchiveEnabled: true, autoArchiveAgeDays: 30, autoArchiveImportance: 1, autoArchiveConflicts: false },
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
      now: () => now,
    });
    const host = new FakeHost();
    await world.start(host);

    const stale = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '上个月的临时安排。', importance: 1 }, CALL)));
    const pinned = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '长期设定：语气用白话。', importance: 1, pinned: true }, CALL)));
    const sacred = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '长期设定：称呼对方。', importance: 5 }, CALL)));

    const later = new Date(now.getTime() + 40 * 86_400_000);
    const result = await world.runMaintenance('manual', later);
    expect(result.archived).toBe(1);
    expect(result.decisions[0]?.id).toBe(stale);

    // 一轮整理只发一条聚合事件，不再逐条发 archived
    const swept = host.events.filter((event) => event.type === 'ink.maintenance.swept');
    expect(swept).toHaveLength(1);
    expect(swept[0].text).toContain('归档 1 条');
    expect(swept[0].text).toContain('久未取用 1 条');
    expect(swept[0].text).toContain('内容重复 0 条');

    const archived = await panel(world, 'library', 'entry', { id: stale });
    expect((archived.data as { archiveReason: string }).archiveReason).toContain('自动归档');
    for (const kept of [pinned, sacred]) {
      const entry = await panel(world, 'library', 'entry', { id: kept });
      expect((entry.data as { archiveReason: string | null }).archiveReason).toBeNull();
    }
    await world.stop();
  });

  it('内容重复的两条留较新的/较重要的那条，另一条归档', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const now = new Date('2026-11-25T12:00:00+08:00');
    const world = new ThePalestInkWorld({
      cfg: {
        ...INK_DEFAULTS,
        autoArchiveEnabled: true,
        autoArchiveAgeDays: 3650,
        autoArchiveImportance: 0,
        autoArchiveConflicts: true,
        conflictSimilarity: 0.82,
      },
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
      now: () => now,
    });
    await world.start(new FakeHost());

    const important = idFrom(
      textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。', kind: 'fact', importance: 3 }, CALL)),
    );
    // 写入查重会拦住第二条，这里要绕过它，专门造出「库里已有两条重复」的局面。
    const duplicate = idFrom(
      textOf(
        await tool(world, 'ink_remember').handler(
          { text: '对方叫林照，负责淡墨这个记忆库项目。', kind: 'fact', importance: 1, force: true },
          CALL,
        ),
      ),
    );

    const result = await world.runMaintenance('manual', now);
    expect(result.archived).toBe(1);
    expect(result.decisions[0]?.id).toBe(duplicate);
    expect(result.decisions[0]?.reason).toContain('内容重复');

    const kept = await panel(world, 'library', 'entry', { id: important });
    expect((kept.data as { archiveReason: string | null }).archiveReason).toBeNull();
    await world.stop();
  });

  it('自动归档总开关关掉后一条都不动', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const now = new Date('2026-11-25T12:00:00+08:00');
    const world = new ThePalestInkWorld({
      cfg: { ...INK_DEFAULTS, autoArchiveEnabled: false, autoArchiveAgeDays: 1, autoArchiveImportance: 4 },
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
      now: () => now,
    });
    await world.start(new FakeHost());
    await tool(world, 'ink_remember').handler({ text: '很久以后也不该被归档。', importance: 0 }, CALL);
    const result = await world.runMaintenance('manual', new Date(now.getTime() + 400 * 86_400_000));
    expect(result.archived).toBe(0);
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

  it('星图面板：只给点与标签圈，按种类过滤，归档默认不画', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = THE_PALEST_INK.create(ctx);
    await world.start(new FakeHost());
    const workId = idFrom(
      textOf(await tool(world, 'ink_remember').handler({ text: '周三要交预算表。', kind: 'todo', tags: ['工作'] }, CALL)),
    );
    const lifeId = idFrom(
      textOf(await tool(world, 'ink_remember').handler({ text: '对方喜欢桂花。', kind: 'preference', tags: ['生活'] }, CALL)),
    );
    await tool(world, 'ink_forget').handler({ id: lifeId }, CALL);

    const map = await panel(world, 'starmap', 'map');
    expect(map.ok).toBe(true);
    const data = map.data as {
      points: Array<{ id: string; tags: string[]; text: string }>;
      tags: Array<{ tag: string; count: number }>;
      counts: { shown: number; matched: number };
      truncated: boolean;
    };
    expect(data.points.map((entry) => entry.id)).toEqual([workId]);
    expect(data.tags).toEqual([{ tag: '工作', count: 1 }]);
    expect(data.counts.shown).toBe(1);
    expect(data.truncated).toBe(false);

    const withArchived = await panel(world, 'starmap', 'map', { includeArchived: true });
    expect((withArchived.data as { points: unknown[] }).points.length).toBe(2);

    const onlyTodo = await panel(world, 'starmap', 'map', { kind: 'todo' });
    expect((onlyTodo.data as { points: Array<{ id: string }> }).points.map((entry) => entry.id)).toEqual([workId]);

    const byTag = await panel(world, 'starmap', 'map', { tag: '工作' });
    expect((byTag.data as { points: Array<{ id: string }> }).points.map((entry) => entry.id)).toEqual([workId]);

    const entryResult = await panel(world, 'starmap', 'entry', { id: workId });
    expect((entryResult.data as { text: string }).text).toContain('预算表');
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


describe('淡墨 · 0.6.0：静音、查重与导入导出', () => {
  function inkWorld(ctx: { dataDir: string }, cfg: Partial<InkConfigSection> = {}): ThePalestInkWorld {
    return new ThePalestInkWorld({
      cfg: { ...INK_DEFAULTS, ...cfg },
      timezone: 'Asia/Shanghai',
      dataDir: ctx.dataDir,
    });
  }

  it('默认 quiet：自己的写入、取用、修订、归档不留回声事件', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx);
    const host = new FakeHost();
    await world.start(host);

    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照。' }, CALL)));
    await tool(world, 'ink_recall').handler({ id }, CALL);
    await tool(world, 'ink_amend').handler({ id, importance: 4 }, CALL);
    await tool(world, 'ink_forget').handler({ id, reason: '记重了' }, CALL);

    expect(host.events.map((event) => event.type)).toEqual(['ink.memory.loaded']);
    await world.stop();
  });

  it('eventLevel=normal 时回声事件照旧发', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx, { eventLevel: 'normal' });
    const host = new FakeHost();
    await world.start(host);

    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照。' }, CALL)));
    await tool(world, 'ink_recall').handler({ id }, CALL);

    expect(host.events.map((event) => event.type)).toEqual([
      'ink.memory.loaded',
      'ink.memory.added',
      'ink.memory.recalled',
    ]);
    await world.stop();
  });

  it('查重拦住几乎一样的第二条，带 force 才能再写', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx);
    await world.start(new FakeHost());

    const first = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。' }, CALL)));
    const blocked = await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。' }, CALL);
    expect(failedOf(blocked)).toBe(true);
    expect(textOf(blocked)).toContain(first);
    expect(textOf(blocked)).toContain('force');

    const forced = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。', force: true }, CALL)));
    expect(forced).not.toBe(first);

    const snapshot = await panel(world, 'library', 'snapshot');
    expect((snapshot.data as { counts: { live: number } }).counts.live).toBe(2);
    await world.stop();
  });

  it('dedupeMode=merge 时把新正文并进旧条目，不多写一条', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx, { dedupeMode: 'merge' });
    await world.start(new FakeHost());

    const first = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '周三下午三点和对方过一遍记忆库的导出。' }, CALL)));
    const merged = textOf(await tool(world, 'ink_remember').handler({ text: '周三下午三点和对方过一遍记忆库的导出，顺带看面板。' }, CALL));
    expect(merged).toContain('已并入');
    expect(merged).toContain(first);

    const full = textOf(await tool(world, 'ink_recall').handler({ id: first }, CALL));
    expect(full).toContain('顺带看面板');
    const snapshot = await panel(world, 'library', 'snapshot');
    expect((snapshot.data as { counts: { live: number } }).counts.live).toBe(1);
    await world.stop();
  });

  it('dedupeMode=off 时不做写入查重', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx, { dedupeMode: 'off' });
    await world.start(new FakeHost());
    await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。' }, CALL);
    await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。' }, CALL);
    const snapshot = await panel(world, 'library', 'snapshot');
    expect((snapshot.data as { counts: { live: number } }).counts.live).toBe(2);
    await world.stop();
  });

  it('数据面板：导出快照、预演、合并导入、覆盖要确认', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = inkWorld(ctx);
    await world.start(new FakeHost());
    idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照，负责淡墨这个记忆库项目。' }, CALL)));

    const status = await panel(world, 'data', 'status');
    expect(status.ok).toBe(true);
    expect((status.data as { counts: { live: number } }).counts.live).toBe(1);

    const exported = await panel(world, 'data', 'export', { includeArchived: true });
    const out = exported.data as { filename: string; json: string; exported: number };
    expect(out.filename).toMatch(/^thepalestink-.*\.json$/);
    expect(out.exported).toBe(1);
    expect(JSON.parse(out.json).entries).toHaveLength(1);

    const incoming = JSON.stringify({
      schema: 1,
      app: 'thepalestink',
      exportedAt: '2026-11-26T00:00:00.000+08:00',
      entries: [{ id: 'mem_import_1', text: '对方出生在杭州，现在住在上海。', kind: 'fact' }],
    });

    const preview = await panel(world, 'data', 'preview', { json: incoming, mode: 'merge' });
    expect((preview.data as { added: number }).added).toBe(1);

    const imported = await panel(world, 'data', 'import', { json: incoming, mode: 'merge' });
    expect((imported.data as { imported: number }).imported).toBe(1);
    expect((imported.data as { backup: string | null }).backup).toContain('.bak-');
    // 语义没开：导入照常落盘，向量留给「嵌入」页，回执里要说明为什么没补。
    const vectorize = (imported.data as { vectorize: { started: boolean; pending: number; reason?: string } }).vectorize;
    expect(vectorize.started).toBe(false);
    expect(vectorize.reason).toContain('语义检索没开');

    const after = await panel(world, 'data', 'status');
    expect((after.data as { counts: { live: number } }).counts.live).toBe(2);

    const refused = await panel(world, 'data', 'import', { json: incoming, mode: 'replace' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('替换');

    const replaced = await panel(world, 'data', 'import', { json: incoming, mode: 'replace', confirm: '替换' });
    expect(replaced.ok).toBe(true);
    expect((replaced.data as { counts: { live: number } }).counts.live).toBe(1);
    await world.stop();
  });

  it('语义开着时：导入后主动补一次向量，不受 embedAutoReindex 限制', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = semanticWorld(ctx, { fetchImpl: fixedVectorFetch([1, 0, 0]) });
    await world.start(new FakeHost());
    const vectorCount = async (): Promise<number> => {
      const status = await panel(world, 'data', 'status');
      return (status.data as { vectorCount: number }).vectorCount;
    };
    idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方叫林照。' }, CALL)));
    await until(async () => (await vectorCount()) === 1);

    const incoming = JSON.stringify({
      schema: 1,
      app: 'thepalestink',
      entries: [{ id: 'mem_import_vec', text: '对方养了一只叫团子的猫。', kind: 'fact' }],
    });
    const imported = await panel(world, 'data', 'import', { json: incoming, mode: 'merge' });
    expect((imported.data as { imported: number }).imported).toBe(1);
    const vectorize = (imported.data as { vectorize: { started: boolean; pending: number } }).vectorize;
    expect(vectorize.started).toBe(true);
    expect(vectorize.pending).toBe(1);
    await until(async () => (await vectorCount()) === 2);
    await world.stop();
  });
});

describe('淡墨 · 0.7.0：情绪记忆', () => {
  function moodWorld(ctx: { dataDir: string }): ThePalestInkWorld {
    return new ThePalestInkWorld({ cfg: { ...INK_DEFAULTS }, timezone: 'Asia/Shanghai', dataDir: ctx.dataDir });
  }

  it('写入时带 mood，回执里有情绪；不填默认 neutral', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = moodWorld(ctx);
    await world.start(new FakeHost());

    const low = textOf(await tool(world, 'ink_remember').handler({ text: '面试没过，但还撑得住。', mood: 'low' }, CALL));
    expect(low).toContain('低落');
    const plain = textOf(await tool(world, 'ink_remember').handler({ text: '今天吃了拉面。' }, CALL));
    expect(plain).toContain('平静');

    const bad = await tool(world, 'ink_remember').handler({ text: '随便。', mood: 'angry' }, CALL);
    expect(failedOf(bad)).toBe(true);
    expect(textOf(bad)).toContain('未知的情绪');
    await world.stop();
  });

  it('ink_mood 回复前取 5 条：同情绪、重要度优先、不含归档', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = moodWorld(ctx);
    await world.start(new FakeHost());

    for (let index = 0; index < 6; index += 1) {
      await tool(world, 'ink_remember').handler({ text: `低落的事 ${index}`, mood: 'low', importance: index, force: true }, CALL);
    }
    await tool(world, 'ink_remember').handler({ text: '高兴的事。', mood: 'happy', importance: 5, force: true }, CALL);
    const archived = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '归档的低落。', mood: 'low', importance: 5, force: true }, CALL)));
    await tool(world, 'ink_forget').handler({ id: archived }, CALL);

    const result = textOf(await tool(world, 'ink_mood').handler({ mood: 'low' }, CALL));
    expect(result).toContain('「低落」的 5 条');
    expect(result).not.toContain(archived);
    expect(result).not.toContain('高兴的事');
    expect(result).toContain('低落的事 5');
    await world.stop();
  });

  it('没有任何同情绪条目时给一句空话，不报错', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = moodWorld(ctx);
    await world.start(new FakeHost());
    const result = textOf(await tool(world, 'ink_mood').handler({ mood: 'clingy' }, CALL));
    expect(result).toContain('还没有标成「黏人」的记忆');
    await world.stop();
  });

  it('amend 能改情绪；search 能按情绪过滤；stats 与面板有情绪分布', async () => {
    const ctx = fakeWorldContext(THE_PALEST_INK, { scratchDir });
    const world = moodWorld(ctx);
    await world.start(new FakeHost());

    const id = idFrom(textOf(await tool(world, 'ink_remember').handler({ text: '对方说这周很难熬。', mood: 'low' }, CALL)));
    await tool(world, 'ink_amend').handler({ id, mood: 'warm' }, CALL);
    const found = textOf(await tool(world, 'ink_search').handler({ mood: 'warm' }, CALL));
    expect(found).toContain(id);
    expect(found).toContain('情绪：温柔');

    const stats = textOf(await tool(world, 'ink_stats').handler({}, CALL));
    expect(stats).toContain('温柔 1');

    const snapshot = await panel(world, 'library', 'snapshot');
    const moods = (snapshot.data as { moods: Array<{ mood: string; count: number }> }).moods;
    expect(moods).toEqual([{ mood: 'warm', label: '温柔', count: 1 }]);
    await world.stop();
  });
});