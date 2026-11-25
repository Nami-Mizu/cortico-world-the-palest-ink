/**
 * 淡墨 · 记忆库的 World 实现：工具接线、事件推送、配置热值同步、面板请求。
 *
 * 分工：
 * - `store.ts` 管落盘与容量，`search.ts` 管排序，`vector.ts` 管向量仓，`embedding.ts` 管 HTTP 与限流；
 *   这里只做「参数校验 → 调它们 → 写回执/推事件 / 回面板 JSON」。
 * - 工具回执写给模型看，事件写给时间线与别的 World 看；面板只给人看，三者不共用同一套措辞。
 * - 任何失败都回 `{ text, failed: true }`，不抛给主循环：模型能读懂并自己改参数重试。
 * - 嵌入是可选的：没配、超时、限流、预算用完，检索都退回字面匹配，绝不让 ink_search 失败。
 */

import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { INK_CONFIG_GROUP, INK_DEFAULTS, EMBED_PRESETS, EMBED_PROTOCOLS, type EmbedProtocol, type InkConfigSection } from './config.ts';
import { EmbeddingClient, EmbeddingError, type EmbeddingSettings, type FetchLike } from './embedding.ts';
import { INK_EVENTS, type InkEventType } from './events.ts';
import { planQuery, searchEntries, type SearchHit } from './search.ts';
import { MemoryStore } from './store.ts';
import { KIND_LABELS, MEMORY_KINDS, type MemoryEntry, type MemoryKind } from './types.ts';
import { clampInt, collapse, nowIso, truncate } from './util.ts';
import { VectorStore, describeEmbedTarget } from './vector.ts';

/** World id：全小写、无连字符，配置路径因此是 `worlds.thepalestink.*`。 */
export const INK_WORLD_ID = 'thepalestink';
/** 显示名。 */
export const INK_LABEL = '淡墨 · 记忆库';
/** 环境提示词模板的绝对路径（describe 导出会读它的原文）。 */
export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 回执里正文的预览长度。 */
const PREVIEW_CHARS = 48;
/** 事件正文里正文的预览长度。 */
const EVENT_PREVIEW_CHARS = 24;
/** 面板里一条正文的预览长度。 */
const PANEL_PREVIEW_CHARS = 160;
/** 自动补向量一次最多补多少条（防止启动时把额度烧光）。 */
const AUTO_BACKFILL_LIMIT = 200;

type InkHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;

const TAGS_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: '标签，用来分组与过滤：最多 12 个，每个 24 字以内，不用带 #。',
};

const KIND_PARAM = {
  type: 'string',
  enum: [...MEMORY_KINDS],
  description: '种类：fact 事实 / event 事件 / preference 偏好 / todo 待办 / note 杂记。缺省 note。',
};

export interface InkWorldOptions {
  cfg: InkConfigSection;
  timezone: string;
  dataDir: string;
  /** 读密钥（部署 .env 或进程环境）；宿主总会给，测试可省略。 */
  secret?: (name: string) => string;
  /** 写密钥到部署 .env；宿主总会给，测试可省略。 */
  storeSecret?: (name: string, value: string) => void;
  /** 深合并配置；面板保存配置用。 */
  persist?: (patch: Record<string, unknown>) => void;
  /** 注入 HTTP 客户端；测试用，不传就走全局 fetch。 */
  fetchImpl?: FetchLike;
}

/** 工具声明；handler 在 `tools()` 里按名字接上。 */
export const INK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'ink_remember',
    description:
      '把一条值得长期记住的事写进记忆库，返回条目 id。正文用一句到几句话写清「谁、什么时候、发生了什么、为什么重要」；不要写寒暄、不要写自己刚读过的原文。' +
      '标签选稳定的名词（人名、项目、主题），重要度 0–5：0 = 随手记，3 = 以后会反复用到，5 = 长期设定。同一件事已经记过时用 ink_amend 改，不要重复写。',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆正文，1–2000 字。' },
        kind: KIND_PARAM,
        tags: TAGS_PARAM,
        source: { type: 'string', description: '来源：哪次对话、哪份文件、谁说的。80 字以内。' },
        importance: { type: 'integer', minimum: 0, maximum: 5, description: '重要度 0–5，缺省读配置 defaultImportance（默认 2）。' },
        pinned: { type: 'boolean', description: '置顶。置顶的条目不会被容量上限淘汰，适合长期设定。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_search',
    description:
      '按关键词检索记忆库，返回带 id 的摘要行。多个词之间是「都要命中」（AND）；中文按子串与相邻两字匹配，英文不分大小写。' +
      '开了语义检索时，意思相近但字面不同的条目也会被找出来。可用 tags（这些标签都要有）、kind、includeArchived 收窄范围。' +
      '命中很少时先换同义词或删掉标签，再看 ink_list。只给 tags/kind、不给 query 时按最近更新返回。结果只给摘要，要全文用 ink_recall。',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，空格分隔多个词；空串表示只按 tags/kind 过滤。' },
        tags: TAGS_PARAM,
        kind: KIND_PARAM,
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回几条，缺省读配置 searchLimit（默认 8）。' },
        includeArchived: { type: 'boolean', description: '连归档一起找，缺省 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_recall',
    description:
      '按 id 读一条记忆的全文（含来源、写入与修订时间、被取用次数），并给它记一次取用。' +
      '读完请基于正文回答或行动；如果发现正文过时或记错了，用 ink_amend 改，不要只在回执里纠正。',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id，形如 mem_xxx；从 ink_search / ink_list / ink_remember 的回执里取。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_amend',
    description:
      '按 id 修订一条记忆：给哪个字段就改哪个，没给的保持原样；改完更新修订时间。正文整体替换，不做增量拼接。' +
      '只改一个细节时也要把完整正文写进来。找不到 id 时先用 ink_search 确认。',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的条目 id。' },
        text: { type: 'string', description: '新的完整正文，1–2000 字。' },
        kind: KIND_PARAM,
        tags: TAGS_PARAM,
        source: { type: 'string', description: '新的来源说明，80 字以内。' },
        importance: { type: 'integer', minimum: 0, maximum: 5, description: '新的重要度 0–5。' },
        pinned: { type: 'boolean', description: '是否置顶。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_forget',
    description:
      '按 id 处理一条不再需要的记忆：默认归档（还在存档里，默认检索看不到，ink_recall 仍能读）。' +
      '只有配置 worlds.thepalestink.hardDeleteOnForget 为 true 时才接受 purge=true 做物理删除，删了不可恢复；' +
      '配置没开时带 purge 会被拒绝，改调归档即可。给 reason 会写进归档记录。',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要处理的条目 id。' },
        reason: { type: 'string', description: '为什么不再需要它；会写进归档记录。' },
        purge: { type: 'boolean', description: 'true = 物理删除（需配置允许）；缺省 false = 归档。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_list',
    description:
      '按最近修订倒序列出记忆，只给摘要行。用于「我最近记了什么」「某个人名下都有什么」这类浏览；' +
      '要按内容找用 ink_search。可用 tag 与 kind 过滤，includeArchived 连归档一起列。',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '列几条，缺省读配置 searchLimit（默认 8）。' },
        tag: { type: 'string', description: '只看带这个标签的条目（不分大小写）。' },
        kind: KIND_PARAM,
        includeArchived: { type: 'boolean', description: '连归档一起列，缺省 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'ink_stats',
    description:
      '报告记忆库的规模（未归档 / 归档 / 置顶）、种类分布、标签榜、被取用最多的条目、语义索引状态与存档文件路径。' +
      '容量接近上限、怀疑存档损坏、想确认写没写进去或嵌入配置对不对时先看它。',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

interface PanelResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 面板「嵌入」卡的状态载荷（与 src/webui/panel-types.ts 的 EmbedSummary 同形）。 */
interface EmbedSummaryPayload {
  enabled: boolean;
  state: 'off' | 'unconfigured' | 'error' | 'ready' | 'partial';
  model: string;
  dims: number;
  indexed: number;
  live: number;
  storageModel: string;
  lastError: string | null;
  usage: {
    day: string;
    calls: number;
    failures: number;
    totalCalls: number;
    lastOkAt?: string;
    lastError?: string;
    budget: number;
  };
  vectorFile: string;
  recovery: string | null;
}

export class ThePalestInkWorld implements World {
  readonly id = INK_WORLD_ID;
  private readonly opts: InkWorldOptions;
  private readonly store: MemoryStore;
  private readonly vectors: VectorStore;
  private readonly handlers: Record<string, InkHandler>;
  private host: WorldHost | null = null;
  /** 最近一次嵌入失败的原因；成功后清掉。 */
  private embedError: string | null = null;
  /** 本次挂载是否已经推过 `ink.embed.ready`。 */
  private embedReadyAnnounced = false;
  /** 补向量单飞：并发触发时共用同一个 Promise。 */
  private backfillRun: Promise<{ indexed: number; failed: number }> | null = null;

  constructor(opts: InkWorldOptions) {
    this.opts = opts;
    this.store = new MemoryStore({
      dataDir: opts.dataDir,
      timezone: opts.timezone,
      maxEntries: opts.cfg.maxEntries,
    });
    this.vectors = new VectorStore({ dataDir: opts.dataDir, timezone: opts.timezone });
    this.handlers = {
      ink_remember: (args, ctx) => this.remember(args, ctx),
      ink_search: (args, ctx) => this.search(args, ctx),
      ink_recall: (args, ctx) => this.recall(args, ctx),
      ink_amend: (args, ctx) => this.amend(args, ctx),
      ink_forget: (args, ctx) => this.forget(args, ctx),
      ink_list: (args, ctx) => this.listRecent(args, ctx),
      ink_stats: (args, ctx) => this.stats(args, ctx),
    };
  }

  /** 环境提示词的变量：条目数、标签榜、容量上限、语义状态。 */
  envPromptVars(): Record<string, string> {
    this.syncConfig();
    const counts = this.store.counts();
    const tags = this.store.topTags(5);
    return {
      'thepalestink.count': String(counts.live),
      'thepalestink.archived': String(counts.archived),
      'thepalestink.maxEntries': String(this.store.limit()),
      'thepalestink.topTags': tags.length ? tags.map(({ tag, count }) => `${tag}(${count})`).join('、') : '（还没有标签）',
      'thepalestink.semantic': this.semanticLine(),
    };
  }

  tools(): ToolDef[] {
    return INK_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.handlers[decl.name] }));
  }

  webUi(language?: string): WorldWebUiDecl {
    void language;
    return {
      label: INK_LABEL,
      config: [INK_CONFIG_GROUP],
      panels: [
        {
          id: 'library',
          title: '记忆库',
          description: '列表、检索与条目全文（只读；写入由模型通过工具完成）。',
        },
        {
          id: 'embedding',
          title: '嵌入',
          description: '引导配置嵌入模型供应商、测试连接、重建向量。',
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.thepalestink.envPrompt',
          title: '淡墨 · 环境提示词',
          description: '记忆库的使用时机、写入标准与协作约定。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'thepalestink.count', description: '未归档的条目数。' },
            { name: 'thepalestink.archived', description: '已归档的条目数。' },
            { name: 'thepalestink.maxEntries', description: '未归档条目的容量上限。' },
            { name: 'thepalestink.topTags', description: '出现最多的五个标签。' },
            { name: 'thepalestink.semantic', description: '语义检索此刻是开着还是关着。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.syncConfig();
    const restored = this.store.recovery();
    if (restored) {
      await this.emit(INK_EVENTS.recovered, `存档读不出来，已改名备份为 ${restored}，记忆库从空库继续。`);
    }
    const counts = this.store.counts();
    await this.emit(
      INK_EVENTS.loaded,
      counts.total
        ? `淡墨已载入：未归档 ${counts.live} 条（置顶 ${counts.pinned}），归档 ${counts.archived} 条。${this.semanticLine()}`
        : `淡墨已载入：记忆库还是空的。${this.semanticLine()}`,
    );
    if (this.semanticEnabled() && this.opts.cfg.embedAutoReindex) {
      // 不挡 start：补向量可能很慢，先让 World 挂上去。
      void this.backfill(AUTO_BACKFILL_LIMIT).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  private async remember(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const result = this.store.add({
        text: this.readText(args.text),
        kind: this.readKind(args.kind),
        tags: this.readTags(args.tags),
        source: this.readSource(args.source),
        importance: args.importance === undefined ? undefined : clampInt(args.importance, 0, 5, this.opts.cfg.defaultImportance),
        pinned: args.pinned === true,
        defaultImportance: this.opts.cfg.defaultImportance,
      });
      const { entry, evicted } = result;
      const lines = [`已记下 ${entry.id}（${KIND_LABELS[entry.kind]}，重要度 ${entry.importance}）：「${truncate(entry.text, PREVIEW_CHARS)}」`];
      if (entry.tags.length) lines.push(`标签：#${entry.tags.join(' #')}`);
      if (evicted.length) lines.push(`容量到顶，已把 ${evicted.length} 条最久没被取用的记忆移入归档：${evicted.map((item) => item.id).join('、')}。`);
      await this.emit(
        INK_EVENTS.added,
        `记下「${truncate(entry.text, EVENT_PREVIEW_CHARS)}」（${entry.id}，${KIND_LABELS[entry.kind]}）`,
      );
      if (evicted.length) {
        await this.emit(INK_EVENTS.evicted, `容量到顶：${evicted.length} 条记忆被移入归档（${evicted.map((item) => item.id).join('、')}）。`);
      }
      void this.indexEntry(entry);
      return lines.join('\n');
    });
  }

  private async search(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const query = typeof args.query === 'string' ? collapse(args.query) : '';
      const tags = this.readTags(args.tags);
      const kind = this.readKind(args.kind);
      const includeArchived = args.includeArchived === true;
      if (!query && !tags?.length && !kind && !includeArchived) {
        throw new Error('query 为空、也没给 tags 或 kind。要按内容找就给关键词，要浏览最近条目请用 ink_list。');
      }
      const limit = this.readLimit(args.limit);
      const { hits, degraded, semantic } = await this.runSearch({
        query,
        tags,
        kind,
        limit,
        includeArchived,
      });
      if (!hits.length) {
        const what = query ? `包含「${truncate(query, 24)}」的` : '符合这些过滤条件的';
        const hint = degraded ? `（语义检索这次没连上：${degraded}）` : '';
        return `没有找到${what}记忆。${hint}可以换同义词、去掉标签过滤，或用 ink_list 看最近写了什么。`;
      }
      const head = query
        ? `找到 ${hits.length} 条（关键词：${query}${semantic ? '，含语义' : ''}）：`
        : `按最近修订列出 ${hits.length} 条：`;
      const lines = [head, ...hits.map((hit, index) => this.entryLine(index + 1, hit.entry))];
      if (degraded) lines.push(`（语义检索这次没连上：${degraded}；以上按字面匹配。）`);
      else if (semantic) lines.push('（带「≈」的行同时命中语义；分数只用于排序，不必向用户报。）');
      lines.push('要全文用 ink_recall（带上面那个 id）。');
      return lines.join('\n');
    });
  }

  private async recall(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const id = this.readId(args.id);
      const entry = this.store.recall(id);
      if (!entry) return this.notFound(id);
      await this.emit(INK_EVENTS.recalled, `取用记忆 ${entry.id}：「${truncate(entry.text, EVENT_PREVIEW_CHARS)}」`);
      return this.entryBlock(entry);
    });
  }

  private async amend(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const id = this.readId(args.id);
      const patch = {
        ...(args.text !== undefined ? { text: this.readText(args.text) } : {}),
        ...(args.kind !== undefined ? { kind: this.readKind(args.kind) } : {}),
        ...(args.tags !== undefined ? { tags: this.readTags(args.tags) ?? [] } : {}),
        ...(args.source !== undefined ? { source: this.readSource(args.source) } : {}),
        ...(args.importance !== undefined ? { importance: clampInt(args.importance, 0, 5, this.opts.cfg.defaultImportance) } : {}),
        ...(args.pinned !== undefined ? { pinned: args.pinned === true } : {}),
      };
      if (!Object.keys(patch).length) {
        throw new Error('没有给要改的字段。至少给 text、tags、kind、importance、pinned、source 里的一个。');
      }
      const entry = this.store.update(id, patch);
      if (!entry) return this.notFound(id);
      await this.emit(INK_EVENTS.amended, `修订记忆 ${entry.id}：「${truncate(entry.text, EVENT_PREVIEW_CHARS)}」`);
      void this.indexEntry(entry);
      return `已修订 ${entry.id}（${KIND_LABELS[entry.kind]}，重要度 ${entry.importance}）：「${truncate(entry.text, PREVIEW_CHARS)}」`;
    });
  }

  private async forget(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const id = this.readId(args.id);
      const reason = typeof args.reason === 'string' ? collapse(args.reason) : '';
      const purge = args.purge === true;
      if (purge) {
        if (!this.opts.cfg.hardDeleteOnForget) {
          return {
            text: '配置没允许真正删除（worlds.thepalestink.hardDeleteOnForget 现在是 false）。改成只归档：不带 purge 再调一次 ink_forget。',
            failed: true,
          };
        }
        const removed = this.store.purge(id);
        if (!removed) return this.notFound(id);
        this.vectors.remove(removed.id);
        await this.emit(INK_EVENTS.purged, `删除记忆 ${removed.id}：「${truncate(removed.text, EVENT_PREVIEW_CHARS)}」`);
        return `已删除 ${removed.id}，不可恢复。`;
      }
      const entry = this.store.archive(id, reason || undefined);
      if (!entry) return this.notFound(id);
      await this.emit(INK_EVENTS.archived, `归档记忆 ${entry.id}${reason ? `（${truncate(reason, EVENT_PREVIEW_CHARS)}）` : ''}`);
      return `已归档 ${entry.id}${reason ? `（${reason}）` : ''}。它不再出现在默认检索与 ink_list 里，但还在存档；ink_recall 仍能读到。`;
    });
  }

  private async listRecent(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const limit = this.readLimit(args.limit);
      const tag = typeof args.tag === 'string' ? collapse(args.tag).toLowerCase() : '';
      const kind = this.readKind(args.kind);
      const includeArchived = args.includeArchived === true;
      const pool = this.store
        .all()
        .filter((entry) => (includeArchived || !entry.archived) && (!kind || entry.kind === kind))
        .filter((entry) => !tag || entry.tags.some((item) => item.toLowerCase() === tag))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.importance - a.importance || a.id.localeCompare(b.id))
        .slice(0, limit);
      if (!pool.length) {
        return tag || kind ? `没有符合条件的记忆（标签：${tag || '不限'}，种类：${kind ? KIND_LABELS[kind] : '不限'}）。` : '记忆库还是空的：还没写过任何条目。';
      }
      return [`最近修订的 ${pool.length} 条：`, ...pool.map((entry, index) => this.entryLine(index + 1, entry))].join('\n');
    });
  }

  private async stats(_args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const counts = this.store.counts();
      const byKind = this.store.byKind();
      const tags = this.store.topTags(8);
      const recalled = this.store.mostRecalled(3);
      const kindLine = MEMORY_KINDS.map((kind) => `${KIND_LABELS[kind]} ${byKind[kind]}`).join(' · ');
      const lines = [
        `未归档 ${counts.live} 条 / 归档 ${counts.archived} 条 / 置顶 ${counts.pinned} 条（上限 ${this.store.limit()} 条）`,
        `种类：${kindLine}`,
        `标签榜：${tags.length ? tags.map(({ tag, count }) => `${tag}(${count})`).join('、') : '（空）'}`,
        `最常取用：${recalled.length ? recalled.map((entry) => `${entry.id}（${entry.recallCount} 次）`).join('、') : '（还没有）'}`,
        `语义索引：${this.indexLine()}`,
        `存档：${this.store.file}`,
      ];
      const restored = this.store.recovery();
      if (restored) lines.push(`上次坏档备份：${restored}`);
      if (counts.live >= this.store.limit()) lines.push('容量已满：再写新条目会开始淘汰最久没被取用的条目，重要设定请置顶。');
      return lines.join('\n');
    });
  }

  // -------------------------------------------------------------------------
  // 语义检索 / 嵌入
  // -------------------------------------------------------------------------

  private semanticEnabled(): boolean {
    return this.opts.cfg.semanticEnabled === true;
  }

  private semanticConfigured(): boolean {
    return Boolean(this.opts.cfg.embedBaseUrl?.trim() && this.opts.cfg.embedModel?.trim());
  }

  private secretName(): string {
    return this.opts.cfg.embedApiKeySecret?.trim() || INK_DEFAULTS.embedApiKeySecret;
  }

  private apiKey(): string {
    const name = this.secretName();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return '';
    try {
      return this.opts.secret?.(name) ?? '';
    } catch {
      return '';
    }
  }

  /** 语义链路此刻是否「可用」：配置齐、有向量仓。真正的连通性由调用结果决定。 */
  private semanticLine(): string {
    if (!this.semanticEnabled()) return '语义检索：关（字面匹配）。';
    if (!this.semanticConfigured()) return '语义检索：开了但还没配嵌入接口，按字面匹配。';
    const indexed = this.vectors.count();
    return `语义检索：开（${this.opts.cfg.embedModel}，已向量化 ${indexed} 条）。`;
  }

  private indexLine(): string {
    if (!this.semanticEnabled()) return '关（只用字面匹配）';
    if (!this.semanticConfigured()) return '未配置（缺接口地址或模型）';
    const usage = this.vectors.usage();
    return `${this.opts.cfg.embedModel} · 已向量化 ${this.vectors.count()}/${this.store.counts().live} 条 · 今日请求 ${usage.calls}/${this.opts.cfg.embedDailyBudget || '∞'}${this.embedError ? ` · 最近失败：${this.embedError}` : ''}`;
  }

  private settings(): EmbeddingSettings {
    return {
      protocol: (EMBED_PROTOCOLS as readonly string[]).includes(this.opts.cfg.embedProtocol)
        ? this.opts.cfg.embedProtocol
        : 'openai',
      baseUrl: this.opts.cfg.embedBaseUrl ?? '',
      model: this.opts.cfg.embedModel ?? '',
      dimensions: Math.max(0, Math.round(this.opts.cfg.embedDimensions ?? 0)),
      apiKey: this.apiKey(),
      timeoutMs: this.opts.cfg.embedTimeoutMs,
      batchSize: this.opts.cfg.embedBatchSize,
      requestsPerMinute: this.opts.cfg.embedRequestsPerMinute,
      concurrency: this.opts.cfg.embedConcurrency,
      maxRetries: this.opts.cfg.embedMaxRetries,
    };
  }

  private client(): EmbeddingClient {
    return new EmbeddingClient({
      settings: this.settings(),
      fetchImpl: this.opts.fetchImpl,
      budget: {
        remaining: () => this.vectors.remainingBudget(this.opts.cfg.embedDailyBudget),
        record: (ok, error) => this.vectors.bumpUsage(ok, error),
      },
    });
  }

  private noteEmbedOk(): void {
    this.embedError = null;
    if (!this.embedReadyAnnounced) {
      this.embedReadyAnnounced = true;
      const dims = this.vectors.dims() || '?';
      void this.emit(INK_EVENTS.embedReady, `嵌入模型已就绪：${this.opts.cfg.embedModel}（${dims} 维），语义检索可用。`);
    }
  }

  private noteEmbedFailure(error: unknown): string {
    const message = error instanceof EmbeddingError ? error.message : error instanceof Error ? error.message : String(error);
    const changed = this.embedError !== message;
    this.embedError = message;
    if (changed) void this.emit(INK_EVENTS.embedFailed, `嵌入调用失败：${truncate(message, 120)}；检索退回字面匹配。`);
    return message;
  }

  /** 给一条记忆补向量；失败不影响写入结果。 */
  private async indexEntry(entry: MemoryEntry): Promise<void> {
    if (!this.semanticEnabled() || !this.semanticConfigured()) return;
    if (entry.archived) return;
    try {
      const { vectors } = await this.client().embed([entry.text]);
      const vector = vectors[0];
      if (!vector) return;
      if (this.vectors.dims() && this.vectors.dims() !== vector.length) {
        this.vectors.reset(this.opts.cfg.embedModel, 0);
      }
      this.vectors.put(entry.id, vector, nowIso(this.opts.timezone));
      this.vectors.prune(new Set(this.store.all().map((item) => item.id)));
      this.noteEmbedOk();
    } catch (error) {
      this.noteEmbedFailure(error);
    }
  }

  /**
   * 补向量：只补缺的（或整仓重建，如果模型/维度变了）。
   * `limit` 限制单次补多少条，防止启动时把额度烧完。
   */
  private backfill(limit: number): Promise<{ indexed: number; failed: number }> {
    if (this.backfillRun) return this.backfillRun;
    const run = (async () => {
      if (!this.semanticEnabled() || !this.semanticConfigured()) return { indexed: 0, failed: 0 };
      const model = this.opts.cfg.embedModel.trim();
      const dims = Math.max(0, Math.round(this.opts.cfg.embedDimensions ?? 0));
      if (this.vectors.model() && (this.vectors.model() !== model || (dims > 0 && this.vectors.dims() !== dims))) {
        this.vectors.reset(model, dims);
      }
      const live = this.store.live();
      const valid = new Set(this.store.all().map((item) => item.id));
      this.vectors.prune(valid);
      const missing = live.filter((entry) => !this.vectors.get(entry.id)).slice(0, limit);
      if (!missing.length) return { indexed: 0, failed: 0 };

      let indexed = 0;
      let failed = 0;
      let firstError: string | null = null;
      const client = this.client();
      const batchSize = Math.max(1, Math.min(64, Math.round(this.opts.cfg.embedBatchSize)));
      for (let index = 0; index < missing.length; index += batchSize) {
        const chunk = missing.slice(index, index + batchSize);
        try {
          const { vectors } = await client.embed(chunk.map((entry) => entry.text));
          chunk.forEach((entry, offset) => {
            const vector = vectors[offset];
            if (vector) {
              this.vectors.put(entry.id, vector, nowIso(this.opts.timezone));
              indexed += 1;
            }
          });
        } catch (error) {
          failed += chunk.length;
          firstError = firstError ?? this.noteEmbedFailure(error);
          // 连不上就别把剩下的条目全试一遍：额度与时间都有限。
          break;
        }
      }
      if (indexed) this.noteEmbedOk();
      if (firstError) {
        await this.emit(INK_EVENTS.embedFailed, `补向量中断：${truncate(firstError, 120)}；已补 ${indexed} 条，剩 ${missing.length - indexed} 条等下次。`);
      }
      if (indexed || failed) {
        await this.emit(INK_EVENTS.reindexed, `向量重建：补了 ${indexed} 条${failed ? `，失败 ${failed} 条` : ''}（模型 ${model}）。`);
      }
      return { indexed, failed };
    })();
    this.backfillRun = run;
    void run.finally(() => {
      this.backfillRun = null;
    });
    return run;
  }

  /** 检索的统一入口：工具与面板共用，保证两边排序、降级口径一致。 */
  private async runSearch(input: {
    query: string;
    tags?: string[];
    kind?: MemoryKind;
    limit: number;
    includeArchived: boolean;
  }): Promise<{ hits: SearchHit[]; degraded: string | null; semantic: boolean }> {
    let queryVector: number[] | null = null;
    let degraded: string | null = null;
    if (this.semanticEnabled() && this.semanticConfigured() && input.query) {
      try {
        const { vectors } = await this.client().embed([input.query]);
        queryVector = vectors[0] ?? null;
        this.noteEmbedOk();
      } catch (error) {
        degraded = this.noteEmbedFailure(error);
      }
    }
    const semantic = queryVector
      ? {
          queryVector,
          weight: Math.max(0, Math.min(1, this.opts.cfg.semanticWeight)),
          vectorFor: (id: string) => this.vectors.get(id),
        }
      : undefined;
    const hits = searchEntries(this.store.all(), {
      query: input.query,
      tags: input.tags,
      kind: input.kind,
      limit: input.limit,
      includeArchived: input.includeArchived,
      semantic,
    });
    return { hits, degraded, semantic: Boolean(semantic) };
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    const arg = (index: number): Record<string, unknown> =>
      args[index] && typeof args[index] === 'object' ? (args[index] as Record<string, unknown>) : {};
    try {
      switch (panel) {
        case 'library':
          switch (method) {
            case 'snapshot':
              this.syncConfig();
              return this.ok(this.librarySnapshot());
            case 'search':
              return this.ok(await this.librarySearch(arg(0)));
            case 'entry':
              return this.ok(this.libraryEntry(arg(0)));
            default:
              return this.fail(`未知方法「${method}」。`);
          }
        case 'embedding':
          switch (method) {
            case 'status':
              return this.ok(this.embeddingStatus());
            case 'save':
              return this.ok(this.saveEmbeddingConfig(arg(0)));
            case 'save-secret':
              return this.ok(this.saveEmbeddingSecret(arg(0)));
            case 'probe':
              return this.ok(await this.probeEmbedding());
            case 'reindex':
              return this.ok(await this.backfill(Number.MAX_SAFE_INTEGER));
            case 'presets':
              return this.ok({ presets: EMBED_PRESETS });
            default:
              return this.fail(`未知方法「${method}」。`);
          }
        default:
          return this.fail(`未知面板「${panel}」。`);
      }
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private ok(data: unknown): PanelResult {
    return { ok: true, data };
  }

  private fail(error: string): PanelResult {
    return { ok: false, error };
  }

  private librarySnapshot(): unknown {
    const counts = this.store.counts();
    const byKind = this.store.byKind();
    const recent = this.store
      .all()
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, 30)
      .map((entry) => this.panelEntry(entry));
    return {
      counts,
      limit: this.store.limit(),
      kinds: MEMORY_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], count: byKind[kind] })),
      tags: this.store.topTags(12),
      recent,
      embed: this.embedSummary(),
      storeFile: this.store.file,
      vectorFile: this.vectors.file,
      recovery: this.store.recovery(),
    };
  }

  private async librarySearch(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === 'string' ? collapse(args.query) : '';
    const tag = typeof args.tag === 'string' ? collapse(args.tag).toLowerCase() : '';
    const kind = this.readKind(args.kind);
    const includeArchived = args.includeArchived === true;
    const limit = clampInt(args.limit, 1, 50, this.readLimit(undefined));
    if (!query && !tag && !kind && !includeArchived) {
      return { hits: [], plan: describePlanText(planQuery('')), degraded: null, semantic: false, hint: '输入关键词，或勾「含归档」。' };
    }
    const { hits, degraded, semantic } = await this.runSearch({
      query,
      tags: tag ? [tag] : undefined,
      kind,
      limit,
      includeArchived,
    });
    return {
      hits: hits.map((hit) => ({ ...this.panelEntry(hit.entry), score: Math.round(hit.score * 10) / 10, semantic: hit.semantic, matched: hit.matched })),
      plan: describePlanText(planQuery(query)),
      degraded,
      semantic,
    };
  }

  private libraryEntry(args: Record<string, unknown>): unknown {
    const id = this.readId(args.id);
    const entry = this.store.get(id);
    if (!entry) throw new Error(`找不到 id 为「${id}」的记忆。`);
    return {
      entry: this.panelEntry(entry),
      text: entry.text,
      source: entry.source,
      archiveReason: entry.archiveReason ?? null,
      lastRecalledAt: entry.lastRecalledAt ?? null,
      vectorized: Boolean(this.vectors.get(id)),
    };
  }

  private panelEntry(entry: MemoryEntry): Record<string, unknown> {
    return {
      id: entry.id,
      text: truncate(entry.text, PANEL_PREVIEW_CHARS),
      fullLength: Array.from(entry.text).length,
      kind: entry.kind,
      kindLabel: KIND_LABELS[entry.kind],
      tags: entry.tags,
      importance: entry.importance,
      pinned: entry.pinned,
      archived: entry.archived,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      recallCount: entry.recallCount,
    };
  }

  private embeddingStatus(): unknown {
    return {
      ...this.embedSummary(),
      presets: EMBED_PRESETS,
      secretName: this.secretName(),
      hasKey: Boolean(this.apiKey()),
      settings: {
        protocol: this.opts.cfg.embedProtocol,
        baseUrl: this.opts.cfg.embedBaseUrl,
        model: this.opts.cfg.embedModel,
        dimensions: this.opts.cfg.embedDimensions,
        apiKeySecret: this.opts.cfg.embedApiKeySecret,
        semanticEnabled: this.opts.cfg.semanticEnabled,
        semanticWeight: this.opts.cfg.semanticWeight,
        batchSize: this.opts.cfg.embedBatchSize,
        timeoutMs: this.opts.cfg.embedTimeoutMs,
        concurrency: this.opts.cfg.embedConcurrency,
        requestsPerMinute: this.opts.cfg.embedRequestsPerMinute,
        maxRetries: this.opts.cfg.embedMaxRetries,
        dailyBudget: this.opts.cfg.embedDailyBudget,
        autoReindex: this.opts.cfg.embedAutoReindex,
      },
      target: describeEmbedTarget(this.opts.cfg.embedProtocol, this.opts.cfg.embedBaseUrl, this.opts.cfg.embedModel),
    };
  }

  private embedSummary(): EmbedSummaryPayload {
    const usage = this.vectors.usage();
    const live = this.store.counts().live;
    const indexed = this.vectors.count();
    const state = !this.semanticEnabled()
      ? 'off'
      : !this.semanticConfigured()
        ? 'unconfigured'
        : this.embedError
          ? 'error'
          : indexed >= live && live > 0
            ? 'ready'
            : 'partial';
    return {
      enabled: this.semanticEnabled(),
      state,
      model: this.opts.cfg.embedModel,
      dims: this.vectors.dims() || this.opts.cfg.embedDimensions || 0,
      indexed,
      live,
      storageModel: this.vectors.model(),
      lastError: this.embedError,
      usage: { ...usage, budget: this.opts.cfg.embedDailyBudget },
      vectorFile: this.vectors.file,
      recovery: this.vectors.recovery(),
    };
  }

  private saveEmbeddingConfig(args: Record<string, unknown>): unknown {
    const patch: Record<string, unknown> = {};
    const putString = (key: keyof InkConfigSection, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value !== 'string') throw new Error(`${key} 要是字符串。`);
      patch[key] = value.trim();
    };
    const putInt = (key: keyof InkConfigSection, value: unknown, min: number, max: number): void => {
      if (value === undefined) return;
      if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${key} 要是整数。`);
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${key} 要是整数。`);
      const rounded = Math.round(parsed);
      if (rounded < min || rounded > max) throw new Error(`${key} 要在 ${min}–${max} 之间。`);
      patch[key] = rounded;
    };
    const putBool = (key: keyof InkConfigSection, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value !== 'boolean') throw new Error(`${key} 要是 true/false。`);
      patch[key] = value;
    };

    if (args.semanticEnabled !== undefined) putBool('semanticEnabled', args.semanticEnabled);
    if (args.autoReindex !== undefined) putBool('embedAutoReindex', args.autoReindex);
    if (args.protocol !== undefined) {
      const protocol = String(args.protocol) as EmbedProtocol;
      if (!(EMBED_PROTOCOLS as readonly string[]).includes(protocol)) throw new Error(`未知协议「${protocol}」。`);
      patch.embedProtocol = protocol;
    }
    if (args.baseUrl !== undefined) {
      const baseUrl = String(args.baseUrl).trim();
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址要以 http:// 或 https:// 开头。');
      patch.embedBaseUrl = baseUrl;
    }
    if (args.model !== undefined) putString('embedModel', args.model);
    if (args.dimensions !== undefined) putInt('embedDimensions', args.dimensions, 0, 8192);
    if (args.semanticWeight !== undefined) {
      const weight = Number(args.semanticWeight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('语义权重要在 0–1 之间。');
      patch.semanticWeight = Math.round(weight * 100) / 100;
    }
    if (args.batchSize !== undefined) putInt('embedBatchSize', args.batchSize, 1, 64);
    if (args.timeoutMs !== undefined) putInt('embedTimeoutMs', args.timeoutMs, 1000, 120000);
    if (args.concurrency !== undefined) putInt('embedConcurrency', args.concurrency, 1, 8);
    if (args.requestsPerMinute !== undefined) putInt('embedRequestsPerMinute', args.requestsPerMinute, 6, 6000);
    if (args.maxRetries !== undefined) putInt('embedMaxRetries', args.maxRetries, 0, 5);
    if (args.dailyBudget !== undefined) putInt('embedDailyBudget', args.dailyBudget, 0, 100000);
    if (args.apiKeySecret !== undefined) {
      const name = String(args.apiKeySecret).trim();
      if (name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error('密钥的环境变量名只能用字母、数字与下划线，且不能以数字开头。');
      }
      patch.embedApiKeySecret = name || INK_DEFAULTS.embedApiKeySecret;
    }
    if (!Object.keys(patch).length) throw new Error('没有要保存的字段。');
    if (!this.opts.persist) throw new Error('当前宿主不支持从面板改配置；请到「配置」页改。');
    this.opts.persist(patch);
    this.syncConfig();
    if (patch.embedModel !== undefined || patch.dimensions !== undefined || patch.baseUrl !== undefined || patch.protocol !== undefined) {
      this.vectors.reset(String(this.opts.cfg.embedModel), 0);
    }
    return { saved: Object.keys(patch), status: this.embeddingStatus() };
  }

  private saveEmbeddingSecret(args: Record<string, unknown>): unknown {
    const value = typeof args.secret === 'string' ? args.secret.trim() : '';
    if (!value) throw new Error('密钥不能为空。');
    if (/\s/.test(value)) throw new Error('密钥里不能有空白字符。');
    if (value.length > 400) throw new Error('密钥太长（超过 400 字符）。');
    if (!this.opts.storeSecret) throw new Error('当前宿主不支持保存密钥；请写进部署 .env。');
    const name = this.secretName();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('密钥的环境变量名不合法，先改「密钥所在的环境变量名」。');
    this.opts.storeSecret(name, value);
    return { saved: true, name };
  }

  private async probeEmbedding(): Promise<unknown> {
    if (!this.semanticConfigured()) throw new Error('先填接口地址与模型，再测试连接。');
    const client = this.client();
    try {
      const result = await client.probe();
      this.noteEmbedOk();
      if (this.vectors.dims() && this.vectors.dims() !== result.dims) {
        this.vectors.reset(this.opts.cfg.embedModel, 0);
      }
      return { ok: true, dims: result.dims, ms: result.ms, state: this.embedSummary() };
    } catch (error) {
      const message = this.noteEmbedFailure(error);
      return { ok: false, error: message, state: this.embedSummary() };
    }
  }

  private async guard(run: () => Promise<string | ToolOutcome>): Promise<string | ToolOutcome> {
    this.syncConfig();
    try {
      return await run();
    } catch (error) {
      return { text: `淡墨：${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }

  /** 配置是活引用：每次调用前把容量上限同步给 store（改小会立刻淘汰）。 */
  private syncConfig(): void {
    const evicted = this.store.setMaxEntries(this.opts.cfg.maxEntries);
    if (evicted.length) {
      void this.emit(INK_EVENTS.evicted, `容量到顶：${evicted.length} 条记忆被移入归档（${evicted.map((entry) => entry.id).join('、')}）。`);
    }
  }

  private async emit(type: InkEventType, text: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
      });
    } catch (error) {
      host.log.warn(`[thepalestink] 事件 ${type} 推送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private entryLine(index: number, entry: MemoryEntry): string {
    const flags = [KIND_LABELS[entry.kind], `重要度 ${entry.importance}`];
    if (entry.pinned) flags.push('置顶');
    if (entry.archived) flags.push('已归档');
    const tags = entry.tags.length ? ` · #${entry.tags.join(' #')}` : '';
    return `${index}. ${entry.id}（${flags.join(' · ')}${tags}）\n   ${truncate(entry.text, PREVIEW_CHARS * 2)}`;
  }

  private entryBlock(entry: MemoryEntry): string {
    const flags = [KIND_LABELS[entry.kind], `重要度 ${entry.importance}`];
    if (entry.pinned) flags.push('置顶');
    if (entry.archived) flags.push(`已归档：${entry.archiveReason ?? '未写原因'}`);
    const lines = [`【${entry.id}】${flags.join(' · ')}`, `正文：${entry.text}`];
    if (entry.tags.length) lines.push(`标签：#${entry.tags.join(' #')}`);
    if (entry.source) lines.push(`来源：${entry.source}`);
    lines.push(
      `写入 ${entry.createdAt}；修订 ${entry.updatedAt}；取用 ${entry.recallCount} 次${entry.lastRecalledAt ? `（最近 ${entry.lastRecalledAt}）` : ''}。`,
    );
    return lines.join('\n');
  }

  private notFound(id: string): ToolOutcome {
    return {
      text: `找不到 id 为「${id}」的记忆。id 形如 mem_xxx；先用 ink_search 找关键词，或用 ink_list 看最近条目。`,
      failed: true,
    };
  }

  private readId(value: unknown): string {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) throw new Error('缺少 id。id 从 ink_search / ink_list / ink_remember 的回执里取，形如 mem_xxx。');
    return id;
  }

  private readText(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('正文不能为空。');
    return value;
  }

  private readSource(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private readKind(value: unknown): MemoryKind | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(value)) {
      throw new Error(`未知的种类「${String(value)}」；可用：${MEMORY_KINDS.map((kind) => `${kind}（${KIND_LABELS[kind]}）`).join('、')}。`);
    }
    return value as MemoryKind;
  }

  private readTags(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new Error('tags 要是字符串数组。');
    return value.filter((tag): tag is string => typeof tag === 'string');
  }

  private readLimit(value: unknown): number {
    const fallback = clampInt(this.opts.cfg.searchLimit, 1, 50, 8);
    return clampInt(value, 1, 50, fallback);
  }
}

/** 面板里展示检索计划用。 */
function describePlanText(plan: ReturnType<typeof planQuery>): string {
  if (!plan.latin.length && !plan.cjk.length) return '（没有检索词）';
  const parts: string[] = [];
  if (plan.latin.length) parts.push(`词 ${plan.latin.join('、')}`);
  if (plan.cjk.length) parts.push(`中文 ${plan.cjk.map((unit) => unit.phrase).join('、')}`);
  return parts.join(' · ');
}
