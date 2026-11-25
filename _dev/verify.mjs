#!/usr/bin/env node
/**
 * 不依赖 vitest / esbuild 的行为自检：直接跑 TypeScript 源码（Node ≥ 22 的类型擦除）。
 *
 * 覆盖：落盘与重载、坏档恢复、容量淘汰、检索排序与归档过滤、修订/取用/归档/删除、
 * 以及 World 的工具回执、事件与配置热值。用法：node _dev/verify.mjs
 *
 * 注意：它不能替代 `pnpm typecheck && pnpm test`；只证明「逻辑跑得通」。
 */

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INK_DEFAULTS } from '../src/config.ts';
import { cronMatches, describeCron, nextCronMatch, parseCron, zonedParts } from '../src/cron.ts';
import { EmbeddingClient } from '../src/embedding.ts';
import { planMaintenance } from '../src/maintenance.ts';
import { searchEntries } from '../src/search.ts';
import { MemoryStore } from '../src/store.ts';
import { VectorStore } from '../src/vector.ts';
import { layoutStarMap } from '../src/webui/starmap-layout.ts';
import { ThePalestInkWorld } from '../src/world.ts';

const failures = [];
let passed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ink-verify-'));
}

// ---------------------------------------------------------------- 落盘与容量
{
  const dir = tempDir();
  const store = new MemoryStore({ dataDir: dir, timezone: 'Asia/Shanghai', maxEntries: 3 });

  const a = store.add({
    text: '林舟喜欢把手写笔记拍成照片存档。',
    kind: 'preference',
    tags: ['林舟', '笔记'],
    importance: 3,
    source: '2026-11-25 对话',
  });
  check('id 前缀', /^mem_[a-z0-9]+$/.test(a.entry.id), a.entry.id);
  check('写入后计数', store.counts().live === 1, JSON.stringify(store.counts()));

  const b = store.add({
    text: '项目淡墨的记忆库在 0.1.0 支持七个工具。',
    kind: 'fact',
    tags: ['淡墨', '项目'],
    importance: 4,
    pinned: true,
    source: 'README',
  });
  store.add({ text: '下周把淡墨的检索排序加一条「置顶优先」。', kind: 'todo', tags: ['淡墨'], importance: 2 });
  const d = store.add({ text: '今天的晚餐是番茄牛腩。', kind: 'note', tags: ['日志'], importance: 0 });

  // 第 4 条写入时超过 maxEntries=3，最久没被取用的 a 应被挤进归档，置顶的 b 留下。
  const afterEvict = store.counts();
  check('容量上限生效', afterEvict.live === 3, JSON.stringify(afterEvict));
  check('置顶不淘汰', store.get(b.entry.id)?.archived === false);
  check('淘汰进归档', store.get(a.entry.id)?.archived === true, JSON.stringify(store.get(a.entry.id)));

  const plain = searchEntries(store.all(), { query: '笔记', now: Date.now() });
  check('归档默认不参与检索', plain.length === 0, `hits=${plain.length}`);
  const withArchive = searchEntries(store.all(), { query: '笔记', includeArchived: true, now: Date.now() });
  check('includeArchived 能查到', withArchive.some((hit) => hit.entry.id === a.entry.id));

  const ink = searchEntries(store.all(), { query: '淡墨', now: Date.now() });
  check('检索命中两条', ink.length === 2, `hits=${ink.length}`);
  check('置顶 + 重要度排在前面', ink[0]?.entry.id === b.entry.id, ink.map((hit) => hit.entry.id).join(','));

  const recalled = store.recall(a.entry.id);
  check('取用计数', recalled?.recallCount === 1, String(recalled?.recallCount));

  const amended = store.update(a.entry.id, { text: '林舟把笔记拍照存档，不存纸质。' });
  check('修订正文', amended?.text === '林舟把笔记拍照存档，不存纸质。');

  check('归档', store.archive(d.entry.id, '吃完饭了')?.archived === true);
  check('归档原因', store.get(d.entry.id)?.archiveReason === '吃完饭了');

  const counts = store.counts();
  check('归档后计数', counts.live === 2 && counts.archived === 2, JSON.stringify(counts));
  check('物理删除', store.purge(d.entry.id)?.id === d.entry.id);
  check('删除后总量', store.counts().total === 3, JSON.stringify(store.counts()));

  // 重新从盘上加载
  const reloaded = new MemoryStore({ dataDir: dir, timezone: 'Asia/Shanghai', maxEntries: 3 });
  check('重载条数', reloaded.counts().total === 3, JSON.stringify(reloaded.counts()));
  check('重载正文', reloaded.get(b.entry.id)?.text === b.entry.text);
  check('重载标签', JSON.stringify(reloaded.get(b.entry.id)?.tags) === JSON.stringify(['淡墨', '项目']));

  // 坏档：改名备份后从空库继续
  writeFileSync(join(dir, 'thepalestink', 'entries.json'), '{oops', 'utf8');
  const broken = new MemoryStore({ dataDir: dir, timezone: 'Asia/Shanghai', maxEntries: 3 });
  check('坏档不抛错', broken.counts().total === 0);
  check('坏档有备份', Boolean(broken.recovery()) && existsSync(broken.recovery()));
  check('备份文件在目录里', readdirSync(join(dir, 'thepalestink')).some((name) => name.includes('.broken-')));
}

// ---------------------------------------------------------------- 置顶可以顶破上限
{
  const store = new MemoryStore({ dataDir: tempDir(), timezone: 'UTC', maxEntries: 1 });
  store.add({ text: '第一条置顶设定。', pinned: true });
  store.add({ text: '第二条置顶设定。', pinned: true });
  check('置顶条目不被淘汰', store.counts().live === 2, JSON.stringify(store.counts()));
}

// ---------------------------------------------------------------- World 接线
{
  const dir = tempDir();
  const events = [];
  const warnings = [];
  const host = {
    pushEvent: async (event) => {
      events.push(event);
      return { ...event, cursor: events.length };
    },
    log: { warn: (message) => warnings.push(String(message)) },
  };
  const cfg = { ...INK_DEFAULTS, maxEntries: 50, searchLimit: 5 };
  const world = new ThePalestInkWorld({ cfg, timezone: 'Asia/Shanghai', dataDir: dir });
  const tools = world.tools();
  const byName = (name) => tools.find((tool) => tool.name === name);

  check('工具数', tools.length === 8, `count=${tools.length}`);
  check('工具前缀', tools.every((tool) => /^ink_/.test(tool.name)));
  check('工具都有 handler', tools.every((tool) => typeof tool.handler === 'function'));

  await world.start(host);
  check('start 推载入事件', events[0]?.type === 'ink.memory.loaded', events[0]?.type);
  check('载入事件是 internal', events[0]?.origin === 'internal');

  const remembered = await byName('ink_remember').handler(
    { text: '对方叫阿棠，做独立游戏，习惯用纸质便签。', tags: ['阿棠'], kind: 'fact', importance: 4 },
    {},
  );
  check('remember 成功', typeof remembered === 'string' && remembered.includes('已记下'), String(remembered));
  const id = String(remembered).match(/mem_[a-z0-9]+/)?.[0] ?? '';
  check('回执带 id', Boolean(id), String(remembered));
  check('写入事件', events.some((event) => event.type === 'ink.memory.added'));

  const searched = await byName('ink_search').handler({ query: '阿棠' }, {});
  check('search 命中', String(searched).includes(id), String(searched));

  const recalled = await byName('ink_recall').handler({ id }, {});
  check('recall 给全文', String(recalled).includes('正文：') && String(recalled).includes('纸质便签'), String(recalled));
  check('取用事件', events.some((event) => event.type === 'ink.memory.recalled'));

  const amended = await byName('ink_amend').handler({ id, importance: 5 }, {});
  check('amend 改重要度', String(amended).includes('重要度 5'), String(amended));

  const noFields = await byName('ink_amend').handler({ id }, {});
  check('amend 空改失败', noFields.failed === true, JSON.stringify(noFields));

  const emptyText = await byName('ink_remember').handler({ text: '   ' }, {});
  check('空正文失败', emptyText.failed === true, JSON.stringify(emptyText));

  const purgeDenied = await byName('ink_forget').handler({ id, purge: true }, {});
  check('配置未开时拒删', purgeDenied.failed === true, JSON.stringify(purgeDenied));

  const archived = await byName('ink_forget').handler({ id, reason: '测试归档' }, {});
  check('归档成功', String(archived).includes('已归档'), String(archived));
  check('归档事件', events.some((event) => event.type === 'ink.memory.archived'));

  const listed = await byName('ink_list').handler({ limit: 5 }, {});
  check('归档后列表为空', String(listed).includes('还是空的') || String(listed).includes('没有'), String(listed));

  const stats = await byName('ink_stats').handler({}, {});
  check('stats 报告路径', String(stats).includes('entries.json'), String(stats));
  check('stats 报告归档数', String(stats).includes('归档 1 条'), String(stats));

  const vars = world.envPromptVars();
  check(
    'envPromptVars 键',
    ['thepalestink.count', 'thepalestink.archived', 'thepalestink.maxEntries', 'thepalestink.topTags', 'thepalestink.semantic', 'thepalestink.expired'].every(
      (key) => key in vars,
    ),
    JSON.stringify(vars),
  );

  const docs = world.webUi().promptDocs ?? [];
  check('promptDocs 六个变量', docs[0]?.vars?.length === 6, JSON.stringify(docs[0]?.vars));
  check('配置文件绝对路径', docs[0]?.path?.endsWith('ENV_PROMPT.md') === true, docs[0]?.path);

  // 配置热改：先写两条活的，再把上限改小；下一次工具调用立刻淘汰。
  await byName('ink_remember').handler({ text: '热改前第一条：淡墨的容量会变。' }, {});
  await byName('ink_remember').handler({ text: '热改前第二条：淡墨的容量会变。' }, {});
  cfg.maxEntries = 1;
  cfg.defaultImportance = 1;
  const second = await byName('ink_remember').handler({ text: '第二条记忆：淡墨的配置是热改的。' }, {});
  check('热改后还能写', typeof second === 'string' && second.includes('已记下'), String(second));
  check('热改触发淘汰事件', events.some((event) => event.type === 'ink.memory.evicted'), events.map((event) => event.type).join(','));
  check('热改默认重要度', String(second).includes('重要度 1'), String(second));

  await world.stop();
  check('无事件推送失败', warnings.length === 0, warnings.join(' | '));
}

// ---------------------------------------------------------------- 时效性记忆
{
  const dir = tempDir();
  const events = [];
  const host = {
    pushEvent: async (event) => {
      events.push(event);
      return { ...event, cursor: events.length };
    },
    log: { warn: () => {} },
  };
  const clock = new Date();
  const cfg = { ...INK_DEFAULTS };
  const world = new ThePalestInkWorld({ cfg, timezone: 'Asia/Shanghai', dataDir: dir, now: () => clock });
  const byName = (name) => world.tools().find((tool) => tool.name === name);
  await world.start(host);

  const remembered = await byName('ink_remember').handler(
    { text: '周末去旧书店取预订的画册。', tags: ['旧书店'], expiresInDays: 1 },
    {},
  );
  const id = String(remembered).match(/mem_[a-z0-9]+/)?.[0] ?? '';
  check('时效回执写明天数', String(remembered).includes('有效期 1 天'), String(remembered));
  check('未过期时清单为空', String(await byName('ink_expired').handler({}, {})).includes('没有过期的记忆'));

  clock.setTime(Date.now() + 3 * 86_400_000);
  const listedExpired = await byName('ink_expired').handler({}, {});
  check('过期后列得出', String(listedExpired).includes(id) && String(listedExpired).includes('⏳'), String(listedExpired));
  const expiredSearch = await byName('ink_search').handler({ query: '旧书店' }, {});
  check('过期仍可搜到并标记', String(expiredSearch).includes('⏳ 已过期'), String(expiredSearch));
  check('stats 报过期待整理', String(await byName('ink_stats').handler({}, {})).includes('过期待整理：1 条'));

  const renewed = await byName('ink_amend').handler({ id, expiresInDays: 30 }, {});
  check('amend 能续期', String(renewed).includes('有效期 30 天'), String(renewed));
  check('续期后不再过期', String(await byName('ink_expired').handler({}, {})).includes('没有过期的记忆'));
  await world.stop();
}

// ---------------------------------------------------------------- 向量 / 嵌入 / 语义检索
{
  const dir = tempDir();
  const vectors = new VectorStore({ dataDir: dir, timezone: 'Asia/Shanghai' });
  vectors.put('mem_a', [0.1, 0.2, 0.3], '2026-01-01T00:00:00+08:00');
  check('向量落盘', new VectorStore({ dataDir: dir, timezone: 'Asia/Shanghai' }).get('mem_a')?.length === 3);
  vectors.reset('m2', 4);
  check('换模型清仓', vectors.count() === 0 && vectors.dims() === 4);

  const json = (status, body, headers = {}) => {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name] ?? null }, text: async () => text };
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const input = body.input ?? [];
    return json(200, { data: input.map((text, index) => ({ index, embedding: [text.length, 1, 0] })) });
  };
  const settings = {
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'fake',
    dimensions: 0,
    apiKey: 'sk-test',
    timeoutMs: 2000,
    batchSize: 2,
    requestsPerMinute: 6000,
    concurrency: 1,
    maxRetries: 1,
  };
  const client = new EmbeddingClient({ settings, fetchImpl, sleep: async () => {} });
  const embedded = await client.embed(['a', 'bb', 'ccc']);
  check('嵌入分批', calls.length === 2, `calls=${calls.length}`);
  check('嵌入保序', JSON.stringify(embedded.vectors) === JSON.stringify([[1, 1, 0], [2, 1, 0], [3, 1, 0]]));

  const budgetClient = new EmbeddingClient({
    settings,
    fetchImpl,
    sleep: async () => {},
    budget: { remaining: () => 0, record: () => {} },
  });
  const budgetError = await budgetClient.embed(['x']).catch((error) => error);
  check('预算用尽报 budget', budgetError?.kind === 'budget', String(budgetError?.kind));

  const base = {
    id: 'mem_x',
    text: 'Zebra crossing etiquette',
    kind: 'note',
    tags: [],
    source: '',
    importance: 2,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
    pinned: false,
    archived: false,
    recallCount: 0,
  };
  const semanticHits = searchEntries([base], {
    query: '斑马线怎么过',
    now: Date.parse('2026-01-02T00:00:00+08:00'),
    semantic: { queryVector: [1, 0, 0], weight: 0.5, vectorFor: () => [1, 0, 0] },
  });
  check('语义能补上字面空缺', semanticHits.length === 1 && semanticHits[0].semantic === 1, String(semanticHits.length));
  const noSemantic = searchEntries([base], { query: '斑马线怎么过', now: Date.parse('2026-01-02T00:00:00+08:00') });
  check('没开语义就找不到', noSemantic.length === 0, String(noSemantic.length));
}

// ---------------------------------------------------------------- 语义 World + 面板
{
  const dir = tempDir();
  const events = [];
  const host = {
    pushEvent: async (event) => {
      events.push(event);
      return { ...event, cursor: events.length };
    },
    log: { warn: (message) => events.push({ type: 'warn', text: String(message) }) },
  };
  const cfg = {
    ...INK_DEFAULTS,
    semanticEnabled: true,
    embedBaseUrl: 'http://127.0.0.1:9/v1',
    embedModel: 'fake-embed',
    embedDimensions: 3,
    embedAutoReindex: false,
  };
  const savedSecrets = [];
  const world = new ThePalestInkWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: dir,
    secret: () => 'sk-test',
    storeSecret: (name, value) => savedSecrets.push([name, value]),
    persist: (patch) => Object.assign(cfg, patch),
    fetchImpl: async (_url, init) => {
      const input = (JSON.parse(init.body).input ?? []);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }),
      };
    },
  });
  await world.start(host);
  const byName = (name) => world.tools().find((tool) => tool.name === name);
  const remembered = String(await byName('ink_remember').handler({ text: '今天学了折纸：鹤与船。' }, {}));
  const id = remembered.match(/mem_[a-z0-9]+/)?.[0] ?? '';
  for (let attempt = 0; attempt < 200 && world.vectors.count() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  check('写入后算了向量', world.vectors.count() === 1, `count=${world.vectors.count()}`);

  const found = String(await byName('ink_search').handler({ query: '量子力学' }, {}));
  check('语义检索命中', found.includes(id) && found.includes('含语义'), found);
  check('就绪事件', events.some((event) => event.type === 'ink.embed.ready'));

  const invoke = (panel, method, args) => world.webUi().invoke(panel, method, args);
  const status = await invoke('embedding', 'status', []);
  check('面板报告 ready', status.ok && status.data.state === 'ready', JSON.stringify(status.data?.state));
  check('面板带预设', status.ok && Array.isArray(status.data.presets) && status.data.presets.length >= 3);
  check('面板知道有密钥', status.ok && status.data.hasKey === true);

  const badSave = await invoke('embedding', 'save', [{ requestsPerMinute: 1 }]);
  check('面板拦住越界限流', badSave.ok === false, JSON.stringify(badSave));
  const goodSave = await invoke('embedding', 'save', [{ requestsPerMinute: 30 }]);
  check('面板保存配置', goodSave.ok === true, JSON.stringify(goodSave));
  const secret = await invoke('embedding', 'save-secret', [{ secret: 'sk-new' }]);
  check('面板存密钥', secret.ok === true && savedSecrets[0]?.[1] === 'sk-new', JSON.stringify(savedSecrets));

  const snapshot = await invoke('library', 'snapshot', []);
  check('记忆库快照', snapshot.ok === true && snapshot.data.counts.total === 1, JSON.stringify(snapshot.data?.counts));
  const panelHits = await invoke('library', 'search', [{ query: '量子力学' }]);
  check('面板检索复用语义', panelHits.ok === true && panelHits.data.hits[0]?.id === id, JSON.stringify(panelHits.data?.hits?.length));

  const starMap = await invoke('starmap', 'map', []);
  check('星图给点', starMap.ok === true && starMap.data.points.length === 1, JSON.stringify(starMap.data?.counts));
  check('星图点带标签字段', Array.isArray(starMap.data.points[0]?.tags), JSON.stringify(starMap.data.points[0]?.tags));
  const starLayout = layoutStarMap(starMap.data.points, starMap.data.tags, 640, 420);
  const starLayoutAgain = layoutStarMap(starMap.data.points, starMap.data.tags, 640, 420);
  check('星图布局可复现', JSON.stringify(starLayoutAgain) === JSON.stringify(starLayout));
  check(
    '星图点在画布内',
    starLayout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.x >= 24 && node.y >= 24 && node.x <= 616 && node.y <= 396),
    JSON.stringify(starLayout.nodes),
  );
  check('星图按种类过滤', (await invoke('starmap', 'map', [{ kind: 'todo' }])).data.points.length === 0);

  await world.stop();
  check('面板调用没推警告', !events.some((event) => event.type === 'warn'), events.filter((event) => event.type === 'warn').map((event) => event.text).join(' | '));
}

// ---------------------------------------------------------------- 提醒与自动归档
{
  const at = new Date('2026-11-25T23:30:00+08:00');

  const spec = parseCron('30 7 * * *');
  check('cron 07:30 命中', cronMatches(spec, zonedParts(new Date('2026-11-25T07:30:00+08:00'), 'Asia/Shanghai')));
  check('cron 07:31 不命中', !cronMatches(spec, zonedParts(new Date('2026-11-25T07:31:00+08:00'), 'Asia/Shanghai')));
  const next = nextCronMatch(spec, new Date('2026-11-25T08:00:00+08:00'), 'Asia/Shanghai');
  check('cron 下次落在明天 07:30', next?.toISOString() === new Date('2026-11-26T07:30:00+08:00').toISOString(), String(next));
  check('cron 描述成人话', describeCron(spec).includes('每天') && describeCron(spec).includes('07:30'), describeCron(spec));

  const stale = {
    id: 'mem_stale',
    text: '上个月的临时安排。',
    kind: 'note',
    tags: [],
    source: '',
    importance: 1,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: new Date(at.getTime() - 40 * 86_400_000).toISOString(),
    pinned: false,
    archived: false,
    recallCount: 0,
  };
  const fresh = { ...stale, id: 'mem_fresh', importance: 3, updatedAt: at.toISOString() };
  const stalePlan = planMaintenance([stale, fresh], { enabled: true, ageDays: 30, importance: 1, conflicts: false, similarity: 0.82 }, at);
  check('过期条目被自动归档', stalePlan.length === 1 && stalePlan[0].id === 'mem_stale', JSON.stringify(stalePlan));

  const dupLow = { ...stale, id: 'mem_low', importance: 1, updatedAt: at.toISOString(), text: fresh.text };
  const conflictPlan = planMaintenance([fresh, dupLow], { enabled: true, ageDays: 3650, importance: 0, conflicts: true, similarity: 0.82 }, at);
  check('重复内容留重要的那条', conflictPlan.length === 1 && conflictPlan[0].id === 'mem_low', JSON.stringify(conflictPlan));
  check('冲突理由写清楚', conflictPlan[0]?.reason.includes('内容重复'), conflictPlan[0]?.reason);

  const dir = tempDir();
  const events = [];
  const host = {
    pushEvent: async (event) => {
      const full = { ...event, cursor: events.length + 1 };
      events.push(full);
      return full;
    },
    store: {
      latestCursor: () => events.length,
      get: (cursor) => events[cursor - 1],
      range: (q) => events.slice(Math.max(0, (q.fromCursor ?? 1) - 1)),
    },
    modelFacts: { model: () => 'test', accepts: () => false, contextWindow: () => 100 },
    log: { warn: (message) => events.push({ type: 'warn', text: String(message) }) },
  };
  const cfg = {
    ...INK_DEFAULTS,
    writeCron: '* * * * *',
    writeCronNote: '重点看项目约定。',
    contextReminderPercent: 10,
    contextReminderCooldownMinutes: 60,
    autoArchiveAgeDays: 30,
    autoArchiveImportance: 1,
    autoArchiveConflicts: false,
  };
  const world = new ThePalestInkWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: dir,
    now: () => at,
    persist: (patch) => Object.assign(cfg, patch),
  });
  await world.start(host);
  const count = (type) => events.filter((event) => event.type === type).length;
  await world.tick(at);
  check('cron 到点推提醒', count('ink.reminder.schedule') === 1, String(count('ink.reminder.schedule')));
  await world.tick(at);
  check('同一分钟不重复', count('ink.reminder.schedule') === 1, String(count('ink.reminder.schedule')));
  await world.tick(new Date(at.getTime() + 60_000));
  check('下一分钟再推', count('ink.reminder.schedule') === 2, String(count('ink.reminder.schedule')));

  await host.pushEvent({
    type: 'chat.message',
    ts: '2026-11-25T23:29:00+08:00',
    source: 'test',
    origin: 'external',
    senderKey: 'user',
    text: '一'.repeat(30),
  });
  await world.tick(new Date(at.getTime() + 2 * 60_000));
  check('上下文过阈值提醒', count('ink.reminder.context') === 1, String(count('ink.reminder.context')));

  world.onHandoffEnded();
  check('交接后提醒补写', count('ink.reminder.handoff') === 1, String(count('ink.reminder.handoff')));

  const byName = (name) => world.tools().find((tool) => tool.name === name);
  await byName('ink_remember').handler({ text: '临时安排，很快会过时。', importance: 1 }, {});
  const maintenance = await world.runMaintenance('manual', new Date(at.getTime() + 40 * 86_400_000));
  check('World 自动归档过期条目', maintenance.archived === 1, JSON.stringify(maintenance.decisions));
  check('归档推事件', count('ink.memory.archived') >= 1, String(count('ink.memory.archived')));

  const snapshot = await world.webUi().invoke('library', 'snapshot', []);
  check('面板有节奏卡', snapshot.ok === true && snapshot.data.rhythm.cronValid === true, JSON.stringify(snapshot.data?.rhythm?.cronValid));
  check('节奏卡带下次时间', typeof snapshot.data.rhythm.cronNextAt === 'string', String(snapshot.data?.rhythm?.cronNextAt));
  check('节奏卡报自动归档', snapshot.data.rhythm.maintenance.enabled === true);
  check('提醒没推警告', !events.some((event) => event.type === 'warn'), events.filter((event) => event.type === 'warn').map((event) => event.text).join(' | '));
  await world.stop();
}

// ---------------------------------------------------------------- 汇总
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${failures.length + passed}`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${passed} checks`);
}
