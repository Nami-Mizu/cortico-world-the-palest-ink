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
import { EMBED_PRESETS, EMBED_PROTOCOLS, INK_CONFIG_GROUP, INK_DEFAULTS, INK_RHYTHM_CONFIG_GROUP, type EmbedProtocol, type InkConfigSection } from './config.ts';
import { cronMatches, describeCron, nextCronMatch, parseCron, zonedParts, type CronSpec } from './cron.ts';
import { DEDUPE_JACCARD, describeDuplicate, findDuplicate } from './dedupe.ts';
import { EmbeddingClient, EmbeddingError, type EmbeddingSettings, type FetchLike } from './embedding.ts';
import { INK_EVENTS, type InkEventType } from './events.ts';
import { planMaintenance, type ArchiveDecision } from './maintenance.ts';
import { planQuery, searchEntries, type SearchHit } from './search.ts';
import { MAX_TEXT_LENGTH, MemoryStore } from './store.ts';
import { buildSnapshot, MAX_IMPORT_ENTRIES, parseSnapshot, planImport, TRANSFER_SCHEMA, type ImportPlan } from './transfer.ts';
import { KIND_LABELS, MAX_TTL_DAYS, MEMORY_KINDS, isExpired, overdueDays, type MemoryEntry, type MemoryKind } from './types.ts';
import { clampInt, collapse, estimateTokens, nowIso, truncate } from './util.ts';
import { VectorStore, describeEmbedTarget } from './vector.ts';
import { MAX_LAYOUT_POINTS } from './webui/starmap-layout.ts';

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
/** 星图上一条记忆的预览长度（悬停提示用，越短越不挤）。 */
const STAR_PREVIEW_CHARS = 60;
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
  /** 注入时钟；测试用。默认取系统时间。 */
  now?: () => Date;
  /** 定时检查的间隔（毫秒）；测试可调大以免真定时。默认 30 秒。 */
  schedulerIntervalMs?: number;
}

/** 工具声明；handler 在 `tools()` 里按名字接上。 */
export const INK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'ink_remember',
    description:
      '把一条值得长期记住的事写进记忆库，返回条目 id。正文用一句到几句话写清「谁、什么时候、发生了什么、为什么重要」；不要写寒暄、不要写自己刚读过的原文。' +
      '标签选稳定的名词（人名、项目、主题），重要度 0–5：0 = 随手记，3 = 以后会反复用到，5 = 长期设定。同一件事已经记过时用 ink_amend 改，不要重复写。' +
      '只是暂时有效的（行程、临时安排、会变的偏好）给 expiresInDays 标个大概天数；到期会提醒你决定续期还是归档。' +
      '写入前会查重：如果和已有条目几乎重复，这次不写，回执会给出旧 id 与相似度——改旧的用 ink_amend；确认是另一件事时再带 force 重写。',
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
        expiresInDays: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_TTL_DAYS,
          description: '大概有效多少天；0 或省略 = 不过期。到期不会自动删，会在整理时间提醒你处理。',
        },
        force: {
          type: 'boolean',
          description: '查重拦下时仍然写：只在确认「这是另一件事，只是说法像」时用；默认 false。',
        },
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
      '只改一个细节时也要把完整正文写进来。找不到 id 时先用 ink_search 确认。给 expiresInDays 可以改有效期（续期或取消时效）。',
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
        expiresInDays: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_TTL_DAYS,
          description: '改有效期：从今天起再有效多少天；0 = 取消时效（永久）。只改正文不会重置到期时间。',
        },
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
    name: 'ink_expired',
    description:
      '列出已经过期、但还没处理的记忆（按到期时间从早到晚），返回 id、摘要、到期日与逾期天数。' +
      '只在「整理时间」的提醒里看到过期数量时用它看全部：决定留下就用 ink_amend 改 expiresInDays 续期（0 = 永久），不要了就用 ink_forget 归档。',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '本次看几条，缺省读配置 searchLimit（默认 8）。' },
        offset: { type: 'integer', minimum: 0, maximum: 10000, description: '跳过前面几条，用来翻页。' },
      },
      required: [],
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

  /** 定时检查的句柄；stop() 时清掉。 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 防止一轮检查还没跑完又进一轮。 */
  private ticking = false;
  /** 上次命中的 cron 分钟（`2026-11-25T07:30`），同一分钟只提醒一次。 */
  private lastCronKey = '';
  /** cron 解析缓存：配置改了就重解析。 */
  private cronSource = '';
  private cronSpec: CronSpec | null = null;
  private cronError: string | null = null;
  /** 上次上下文提醒的时刻（毫秒）。 */
  private lastContextReminderAt = 0;
  /** 上次自动归档检查的时刻（毫秒）。 */
  private lastMaintenanceAt = 0;
  /** 交接时的游标：之后的上下文估算只数这之后的事件。 */
  private handoffCursor = 0;
  /** 估算出的上下文用量，面板展示用。 */
  private contextEstimate: { tokens: number; window: number | null; percent: number | null } = {
    tokens: 0,
    window: null,
    percent: null,
  };
  /** 最近一次自动归档的结果。 */
  private maintenanceStats: { lastRunAt: string | null; lastArchived: number; totalArchived: number; sample: ArchiveDecision[] } = {
    lastRunAt: null,
    lastArchived: 0,
    totalArchived: 0,
    sample: [],
  };
  /** 最近一次推出去的提醒，面板上能看见「上次提醒是什么时候」。 */
  private lastReminder: { kind: 'schedule' | 'context' | 'handoff'; at: string; text: string } | null = null;
  /** 最近一次导入前的备份路径。 */
  private lastBackup: string | null = null;
  /** 最近一次导入的时间。 */
  private lastImportAt: string | null = null;

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
      ink_expired: (args, ctx) => this.expired(args, ctx),
      ink_list: (args, ctx) => this.listRecent(args, ctx),
      ink_stats: (args, ctx) => this.stats(args, ctx),
    };
  }

  /** 环境提示词的变量：条目数、标签榜、容量上限、语义状态、过期待整理数。 */
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
      'thepalestink.expired': String(this.store.expiredCount(this.now())),
    };
  }

  tools(): ToolDef[] {
    return INK_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.handlers[decl.name] }));
  }

  webUi(language?: string): WorldWebUiDecl {
    void language;
    return {
      label: INK_LABEL,
      config: [INK_CONFIG_GROUP, INK_RHYTHM_CONFIG_GROUP],
      panels: [
        {
          id: 'library',
          title: '记忆库',
          description: '列表、检索与条目全文（只读；写入由模型通过工具完成）。',
        },
        {
          id: 'starmap',
          title: '星图',
          description: '每条记忆一个点，圆圈是标签的引力范围；点的大小是重要度（只读）。',
        },
        {
          id: 'embedding',
          title: '嵌入',
          description: '引导配置嵌入模型供应商、测试连接、重建向量。',
        },
        {
          id: 'data',
          title: '数据',
          description: '导出快照、从文件导入；导入前先预演，写盘前自动备份（唯一会改存档的人工操作）。',
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
            { name: 'thepalestink.expired', description: '已过期、还没整理的条目数。' },
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
    // 启动时先查一次自动归档：上次关机的这段时间也该按规则收拾。
    void this.runMaintenance('start').catch(() => undefined);
    this.startScheduler();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
  }

  /**
   * 交接完成后：重设上下文估算的起点，并（可选）提醒补写。
   * 宿主没有「交接开始前」的钩子，所以这条提醒落在交接后的第一批。
   */
  onHandoffEnded(): void {
    this.handoffCursor = this.host?.store.latestCursor() ?? this.handoffCursor;
    this.lastContextReminderAt = 0;
    if (!this.opts.cfg.handoffReminder) return;
    const text =
      '上下文刚交接完：交接前会话里的细节，现在只剩摘要了。如果其中有之后会用到的——做过什么、为什么那么定、对方提过什么要求——趁摘要里还留着线索，用 ink_remember 补上；已经在库里的别重复写。';
    this.lastReminder = { kind: 'handoff', at: nowIso(this.opts.timezone, this.now()), text };
    void this.emit(INK_EVENTS.handoffReminder, text);
  }

  /** 启动定时检查；间隔可注入，测试里调大即可不真等。 */
  private startScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    const interval = Math.max(1000, this.opts.schedulerIntervalMs ?? 30_000);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // 别让这个定时器把宿主进程吊住（Node 的 Timeout 才有 unref）。
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  /**
   * 一轮检查：cron 到点、上下文过阈值、自动归档到期。
   * 公开给测试与面板用；`now` 可注入，行为完全可复现。
   */
  async tick(now: Date = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.checkSchedule(now);
      await this.checkContextReminder(now);
      this.maybeMaintenance(now);
    } catch (error) {
      this.host?.log.warn(`[thepalestink] 提醒检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** cron 到点就推一条「该回顾了」。同一分钟只推一次。 */
  private async checkSchedule(now: Date): Promise<void> {
    const expr = this.opts.cfg.writeCron.trim();
    if (!expr) {
      this.cronSpec = null;
      this.cronSource = '';
      this.cronError = null;
      return;
    }
    if (this.cronSource !== expr) {
      this.cronSource = expr;
      try {
        this.cronSpec = parseCron(expr);
        this.cronError = null;
      } catch (error) {
        this.cronSpec = null;
        this.cronError = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    const spec = this.cronSpec;
    if (!spec) return;
    const parts = zonedParts(now, this.opts.timezone);
    if (!cronMatches(spec, parts)) return;
    const key = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
    if (key === this.lastCronKey) return;
    this.lastCronKey = key;
    const expiredCount = this.store.expiredCount(now);
    const lines = expiredCount
      ? [
          `到点了（${describeCron(spec)}，cron「${expr}」）。记忆库里有 ${expiredCount} 条已经过期：用 ink_expired 看全部。` +
            '决定留下就用 ink_amend 改 expiresInDays 续期（0 = 永久），不要了就用 ink_forget 归档；别只把结论说给我听，库里的条目才算数。',
        ]
      : [
          `到点了（${describeCron(spec)}，cron「${expr}」）。花一分钟回顾这段时间：对方说过的偏好、定下来的事、还没做完的待办，有没有值得留下的。`,
        ];
    const note = this.opts.cfg.writeCronNote.trim();
    if (note) lines.push(note);
    lines.push(
      expiredCount
        ? '整理完再顺手回顾一下这段时间有没有新的值得写的；写之前先 ink_search 查重。'
        : '写之前先 ink_search 查重；重复的用 ink_amend 改。一次写 1–3 条就够，没有值得写的就不写。',
    );
    const text = lines.join('\n');
    this.lastReminder = { kind: 'schedule', at: nowIso(this.opts.timezone, now), text };
    await this.emit(INK_EVENTS.scheduleReminder, text);
  }

  /**
   * 上下文估算过阈值就提醒。
   *
   * 宿主没把 token 用量交给 World，这里按「交接以来事件里的字数」粗估：
   * 中日韩一字一 token、其余 3.6 字符一 token。工具回执不在事件里，所以只会低估，不会虚报。
   */
  private async checkContextReminder(now: Date): Promise<void> {
    const percentLimit = clampInt(this.opts.cfg.contextReminderPercent, 0, 95, 0);
    const window = this.host?.modelFacts.contextWindow() ?? null;
    const used = this.estimateContextTokens();
    const percent = window ? Math.min(999, Math.round((used / window) * 100)) : null;
    this.contextEstimate = { tokens: used, window, percent };
    if (!percentLimit || !window || percent === null) return;
    if (percent < percentLimit) return;
    const cooldownMs = clampInt(this.opts.cfg.contextReminderCooldownMinutes, 5, 1440, 60) * 60_000;
    if (this.lastContextReminderAt && now.getTime() - this.lastContextReminderAt < cooldownMs) return;
    this.lastContextReminderAt = now.getTime();
    const text = `上下文估到 ${percent}%（约 ${used} / ${window} token，按字数粗估）。趁细节还在，把之后会用到的写下来：正在做的事的进展、约定、还没解决的问题。交接之后这些就只剩摘要了。`;
    this.lastReminder = { kind: 'context', at: nowIso(this.opts.timezone, now), text };
    await this.emit(INK_EVENTS.contextReminder, text);
  }

  /** 交接以来（或启动以来）的事件字数换算成 token。 */
  private estimateContextTokens(): number {
    const host = this.host;
    if (!host) return 0;
    try {
      const events = host.store.range({ fromCursor: this.handoffCursor + 1 });
      let total = 0;
      for (const event of events.slice(-2000)) total += estimateTokens(event.text ?? '');
      return total;
    } catch {
      return 0;
    }
  }

  /** 到间隔就做一次自动归档检查；不 await，免得拖住 tick。 */
  private maybeMaintenance(now: Date): void {
    const intervalMs = clampInt(this.opts.cfg.maintenanceIntervalMinutes, 5, 1440, 60) * 60_000;
    if (this.lastMaintenanceAt && now.getTime() - this.lastMaintenanceAt < intervalMs) return;
    void this.runMaintenance('timer', now).catch(() => undefined);
  }

  /**
   * 自动归档：低价值、久未取用的进归档；重复/冲突的留较新那条。
   * 返回实际归档了哪些，方便测试与面板。
   */
  async runMaintenance(reason: 'start' | 'timer' | 'manual' = 'timer', now: Date = this.now()): Promise<{ archived: number; decisions: ArchiveDecision[] }> {
    this.lastMaintenanceAt = now.getTime();
    const cfg = this.opts.cfg;
    const decisions = planMaintenance(
      this.store.all(),
      {
        enabled: cfg.autoArchiveEnabled,
        ageDays: clampInt(cfg.autoArchiveAgeDays, 1, 3650, 30),
        importance: clampInt(cfg.autoArchiveImportance, 0, 4, 1),
        conflicts: cfg.autoArchiveConflicts,
        similarity: clamp01(cfg.conflictSimilarity, 0.82),
      },
      now,
    );
    const applied: ArchiveDecision[] = [];
    for (const decision of decisions) {
      const entry = this.store.archive(decision.id, decision.reason);
      if (!entry) continue;
      applied.push(decision);
    }
    // 自动整理一轮只发一条：逐条发会把时间线刷满，而模型关心的只是「收拾了几条、为什么」。
    if (applied.length) {
      const stale = applied.filter((decision) => decision.kind === 'stale').length;
      const conflict = applied.length - stale;
      const sample = applied.slice(0, 5).map((decision) => decision.id).join('、');
      await this.emit(
        INK_EVENTS.swept,
        `自动整理：归档 ${applied.length} 条（久未取用 ${stale} 条、内容重复 ${conflict} 条${sample ? `；${sample}` : ''}）。归档不是删除，ink_recall 仍读得到。`,
      );
    }
    this.maintenanceStats = {
      lastRunAt: nowIso(this.opts.timezone, now),
      lastArchived: applied.length,
      totalArchived: this.maintenanceStats.totalArchived + applied.length,
      sample: applied.slice(0, 5),
    };
    if (reason !== 'manual' && applied.length) {
      this.host?.log.info(`[thepalestink] 自动归档 ${applied.length} 条（${reason}）`);
    }
    return { archived: applied.length, decisions: applied };
  }

  private async remember(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const text = this.readText(args.text);
      const kind = this.readKind(args.kind);
      const mode = this.opts.cfg.dedupeMode === 'merge' ? 'merge' : this.opts.cfg.dedupeMode === 'off' ? 'off' : 'warn';
      if (args.force !== true && mode !== 'off') {
        const match = findDuplicate(this.store.all(), text, {
          kind,
          threshold: clamp01(this.opts.cfg.dedupeThreshold, DEDUPE_JACCARD),
        });
        if (match) {
          const note = describeDuplicate(match);
          if (mode === 'merge') {
            const merged = `${match.entry.text}\n${text}`;
            if (merged.length > MAX_TEXT_LENGTH) {
              return {
                text: `没合并：${match.entry.id} 的正文加上这条会超过 ${MAX_TEXT_LENGTH} 字。用 ink_amend 精简旧条目，或把这条拆短再写。`,
                failed: true,
              };
            }
            const updated = this.store.update(match.entry.id, { text: merged });
            if (!updated) return this.notFound(match.entry.id);
            void this.indexEntry(updated);
            return `已并入 ${updated.id}（${note}），现在 ${merged.length} 字：「${truncate(updated.text, PREVIEW_CHARS)}」`;
          }
          return {
            text:
              `没写：这条和 ${match.entry.id} 很像（${note}）：「${truncate(match.entry.text, PREVIEW_CHARS)}」。\n` +
              '如果说的是同一件事，用 ink_amend 改旧的（或改有效期）；确认是另一件事、只是说法像，再带 force: true 重写一次。',
            failed: true,
          };
        }
      }
      const result = this.store.add({
        text,
        kind,
        tags: this.readTags(args.tags),
        source: this.readSource(args.source),
        importance: args.importance === undefined ? undefined : clampInt(args.importance, 0, 5, this.opts.cfg.defaultImportance),
        pinned: args.pinned === true,
        defaultImportance: this.opts.cfg.defaultImportance,
        expiresInDays: args.expiresInDays === undefined ? undefined : clampInt(args.expiresInDays, 0, MAX_TTL_DAYS, 0),
      });
      const { entry, evicted } = result;
      const lines = [`已记下 ${entry.id}（${KIND_LABELS[entry.kind]}，重要度 ${entry.importance}）：「${truncate(entry.text, PREVIEW_CHARS)}」`];
      if (entry.tags.length) lines.push(`标签：#${entry.tags.join(' #')}`);
      if (entry.ttlDays > 0 && entry.expiresAt) {
        lines.push(`有效期 ${entry.ttlDays} 天，${entry.expiresAt.slice(0, 10)} 到期（不会自动删，到整理时间会提醒你处理）。`);
      }
      if (evicted.length) lines.push(`容量到顶，已把 ${evicted.length} 条最久没被取用的记忆移入归档：${evicted.map((item) => item.id).join('、')}。`);
      await this.emitTool(
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
      if (hits.some((hit) => hit.expired)) {
        lines.push('（带「⏳ 已过期」的内容可能已经不准：仍然可以读，但别直接当现状用；确定还成立就用 ink_amend 续期，不成立就改正文或 ink_forget 归档。）');
      }
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
      await this.emitTool(INK_EVENTS.recalled, `取用记忆 ${entry.id}：「${truncate(entry.text, EVENT_PREVIEW_CHARS)}」`);
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
        ...(args.expiresInDays !== undefined ? { expiresInDays: clampInt(args.expiresInDays, 0, MAX_TTL_DAYS, 0) } : {}),
      };
      if (!Object.keys(patch).length) {
        throw new Error('没有给要改的字段。至少给 text、tags、kind、importance、pinned、source、expiresInDays 里的一个。');
      }
      const entry = this.store.update(id, patch);
      if (!entry) return this.notFound(id);
      await this.emitTool(INK_EVENTS.amended, `修订记忆 ${entry.id}：「${truncate(entry.text, EVENT_PREVIEW_CHARS)}」`);
      void this.indexEntry(entry);
      const ttl = entry.ttlDays > 0 && entry.expiresAt
        ? `有效期 ${entry.ttlDays} 天，${entry.expiresAt.slice(0, 10)} 到期。`
        : '不设时效（永久）。';
      return `已修订 ${entry.id}（${KIND_LABELS[entry.kind]}，重要度 ${entry.importance}）：「${truncate(entry.text, PREVIEW_CHARS)}」${ttl}`;
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
        await this.emitTool(INK_EVENTS.purged, `删除记忆 ${removed.id}：「${truncate(removed.text, EVENT_PREVIEW_CHARS)}」`);
        return `已删除 ${removed.id}，不可恢复。`;
      }
      const entry = this.store.archive(id, reason || undefined);
      if (!entry) return this.notFound(id);
      await this.emitTool(INK_EVENTS.archived, `归档记忆 ${entry.id}${reason ? `（${truncate(reason, EVENT_PREVIEW_CHARS)}）` : ''}`);
      return `已归档 ${entry.id}${reason ? `（${reason}）` : ''}。它不再出现在默认检索与 ink_list 里，但还在存档；ink_recall 仍能读到。`;
    });
  }

  /** 过期清单：只读，用来在「整理时间」一次性看全部。 */
  private async expired(args: Record<string, unknown>, _ctx: ToolCallContext): Promise<string | ToolOutcome> {
    return this.guard(async () => {
      const now = this.now();
      const all = this.store.expired(now);
      if (!all.length) {
        return '没有过期的记忆。写过时用 ink_remember 的 expiresInDays 标注；到期后会在整理时间提醒你处理。';
      }
      const limit = clampInt(args.limit, 1, 50, this.readLimit(undefined));
      const offset = clampInt(args.offset, 0, 10000, 0);
      const page = all.slice(offset, offset + limit);
      const head =
        offset > 0 || page.length < all.length
          ? `过期未整理：共 ${all.length} 条，这里是第 ${offset + 1}–${offset + page.length} 条（按到期时间从早到晚）：`
          : `过期未整理：共 ${all.length} 条（按到期时间从早到晚）：`;
      const lines = [head];
      page.forEach((entry, index) => {
        const days = overdueDays(entry, now);
        const tags = entry.tags.length ? `｜#${entry.tags.join(' #')}` : '';
        lines.push(
          `${offset + index + 1}. ${entry.id} ⏳ ${(entry.expiresAt ?? '').slice(0, 10)} 到期（逾期 ${days} 天）｜重要度 ${entry.importance}${tags}｜「${truncate(entry.text, PREVIEW_CHARS)}」`,
        );
      });
      if (offset + page.length < all.length) {
        lines.push(`还有 ${all.length - offset - page.length} 条，用 offset=${offset + page.length} 接着看。`);
      }
      lines.push('决定留就 ink_amend 改 expiresInDays 续期（0 = 永久）；不要了就 ink_forget 归档；拿不准先 ink_recall 看全文。');
      return lines.join('\n');
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
        `过期待整理：${this.store.expiredCount(this.now())} 条`,
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
        case 'starmap':
          switch (method) {
            case 'map':
              this.syncConfig();
              return this.ok(this.starMap(arg(0)));
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
        case 'data':
          switch (method) {
            case 'status':
              this.syncConfig();
              return this.ok(this.dataStatus());
            case 'export':
              return this.ok(this.exportMemory(arg(0)));
            case 'preview':
              return this.ok(this.previewImport(arg(0)));
            case 'import':
              return this.ok(this.importMemory(arg(0)));
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

  // -------------------------------------------------------------------------
  // 数据面板：导出 / 预演 / 导入
  // -------------------------------------------------------------------------

  private dataStatus(): unknown {
    return {
      counts: this.store.counts(),
      expired: this.store.expiredCount(this.now()),
      storeFile: this.store.file,
      vectorFile: this.vectors.file,
      entriesBytes: this.store.bytes(),
      vectorCount: this.vectors.count(),
      lastBackup: this.lastBackup,
      lastImportAt: this.lastImportAt,
      maxImportEntries: MAX_IMPORT_ENTRIES,
      schema: TRANSFER_SCHEMA,
    };
  }

  /** 导出成一份快照文本；面板把它存成文件。 */
  private exportMemory(args: Record<string, unknown>): unknown {
    const includeArchived = args.includeArchived !== false;
    const entries = includeArchived ? this.store.all() : this.store.live();
    const at = this.now();
    const json = buildSnapshot(entries, nowIso(this.opts.timezone, at));
    const stamp = nowIso(this.opts.timezone, at).slice(0, 16).replace(/[:T]/g, '-');
    return {
      filename: `thepalestink-${stamp}.json`,
      json,
      exported: entries.length,
      archived: entries.filter((entry) => entry.archived).length,
      bytes: Buffer.byteLength(json, 'utf8'),
      note: '快照只含正文与元数据，不含向量；导入后语义检索会按需补向量。',
    };
  }

  private previewImport(args: Record<string, unknown>): unknown {
    const snapshot = parseSnapshot(typeof args.json === 'string' ? args.json : '');
    const mode = args.mode === 'replace' ? 'replace' : 'merge';
    const plan = planImport(this.store.all(), snapshot.entries, {
      mode,
      threshold: clamp01(this.opts.cfg.dedupeThreshold, DEDUPE_JACCARD),
    });
    return { ...this.planSummary(plan), exportedAt: snapshot.exportedAt, local: this.store.counts() };
  }

  private importMemory(args: Record<string, unknown>): unknown {
    const snapshot = parseSnapshot(typeof args.json === 'string' ? args.json : '');
    const mode = args.mode === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace' && collapse(typeof args.confirm === 'string' ? args.confirm : '') !== '替换') {
      throw new Error('覆盖导入会让本地记忆只剩文件里那些；确认的话在「确认」里输入「替换」两个字。');
    }
    const plan = planImport(this.store.all(), snapshot.entries, {
      mode,
      threshold: clamp01(this.opts.cfg.dedupeThreshold, DEDUPE_JACCARD),
    });
    if (!plan.added.length) {
      return { ...this.planSummary(plan), imported: 0, backup: null, note: '没有可导入的新条目。' };
    }
    // 先备份再写：覆盖模式尤其要留后路。
    const backup = this.store.backup();
    let imported = 0;
    if (mode === 'replace') {
      imported = this.store.replaceAll(plan.added);
      this.vectors.prune(new Set(this.store.all().map((entry) => entry.id)));
    } else {
      for (const item of plan.added) if (this.store.adopt(item)) imported += 1;
    }
    this.lastBackup = backup;
    this.lastImportAt = nowIso(this.opts.timezone, this.now());
    if (this.semanticEnabled() && this.opts.cfg.embedAutoReindex) {
      void this.backfill(AUTO_BACKFILL_LIMIT).catch(() => undefined);
    }
    return { ...this.planSummary(plan), imported, backup, counts: this.store.counts() };
  }

  private planSummary(plan: ImportPlan): Record<string, unknown> {
    return {
      mode: plan.mode,
      incoming: plan.incoming,
      added: plan.added.length,
      skipped: plan.skipped,
      duplicates: plan.duplicates.slice(0, 8),
      duplicateCount: plan.duplicates.length,
      invalid: plan.invalid,
      samples: plan.samples,
    };
  }

  private ok(data: unknown): PanelResult {
    return { ok: true, data };
  }
  private fail(error: string): PanelResult {
    return { ok: false, error };
  }

  private librarySnapshot(): unknown {
    const now = this.now();
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
      expired: {
        count: this.store.expiredCount(now),
        items: this.store.expired(now).slice(0, 5).map((entry) => this.panelEntry(entry)),
      },
      embed: this.embedSummary(),
      rhythm: this.rhythmSummary(),
      storeFile: this.store.file,
      vectorFile: this.vectors.file,
      recovery: this.store.recovery(),
    };
  }

  /**
   * 星图数据：只给画图需要的字段，正文截到 60 字。
   * 排序固定（按修订时间倒序、id 升序），布局的抖动才可复现。
   */
  private starMap(args: Record<string, unknown>): unknown {
    const kind = this.readKind(args.kind);
    const tag = typeof args.tag === 'string' ? collapse(args.tag).toLowerCase() : '';
    const includeArchived = args.includeArchived === true;
    const matched = this.store.all().filter((entry) => {
      if (!includeArchived && entry.archived) return false;
      if (kind && entry.kind !== kind) return false;
      if (tag && !entry.tags.includes(tag)) return false;
      return true;
    });
    const limit = includeArchived
      ? MAX_LAYOUT_POINTS
      : Math.min(MAX_LAYOUT_POINTS, Math.max(1, this.store.limit()));
    const shown = matched
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit);
    const now = this.now();

    const counter = new Map<string, number>();
    for (const entry of shown) {
      for (const name of entry.tags) counter.set(name, (counter.get(name) ?? 0) + 1);
    }
    const tags = [...counter.entries()]
      .map(([name, count]) => ({ tag: name, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
      .slice(0, 24);

    return {
      points: shown.map((entry) => ({
        id: entry.id,
        text: truncate(entry.text, STAR_PREVIEW_CHARS),
        kind: entry.kind,
        tags: entry.tags,
        importance: entry.importance,
        pinned: entry.pinned,
        archived: entry.archived,
        expired: isExpired(entry, now),
        recallCount: entry.recallCount,
        updatedAt: entry.updatedAt,
      })),
      tags,
      counts: { shown: shown.length, matched: matched.length, ...this.store.counts() },
      truncated: matched.length > shown.length,
    };
  }

  /** 面板「写记忆的节奏」卡的数据：提醒条件、下次到点、最近一次自动归档。 */
  private rhythmSummary(): unknown {
    const cfg = this.opts.cfg;
    const expr = cfg.writeCron.trim();
    const upcoming = this.upcomingCron(expr);
    return {
      cron: expr,
      cronValid: upcoming.valid,
      cronError: upcoming.error,
      cronNextAt: upcoming.nextAt,
      cronText: upcoming.text,
      contextPercentLimit: clampInt(cfg.contextReminderPercent, 0, 95, 0),
      contextCooldownMinutes: clampInt(cfg.contextReminderCooldownMinutes, 5, 1440, 60),
      estimatedTokens: this.contextEstimate.tokens,
      contextWindow: this.contextEstimate.window,
      estimatedPercent: this.contextEstimate.percent,
      handoffReminder: cfg.handoffReminder,
      lastReminder: this.lastReminder,
      maintenance: {
        enabled: cfg.autoArchiveEnabled,
        ageDays: clampInt(cfg.autoArchiveAgeDays, 1, 3650, 30),
        importance: clampInt(cfg.autoArchiveImportance, 0, 4, 1),
        conflicts: cfg.autoArchiveConflicts,
        similarity: clamp01(cfg.conflictSimilarity, 0.82),
        lastRunAt: this.maintenanceStats.lastRunAt,
        lastArchived: this.maintenanceStats.lastArchived,
        totalArchived: this.maintenanceStats.totalArchived,
        sample: this.maintenanceStats.sample,
      },
    };
  }

  /** 解析 cron 并给出「下次什么时候」；解析失败时把原因带回面板。 */
  private upcomingCron(expr: string): { valid: boolean; error: string | null; nextAt: string | null; text: string | null } {
    if (!expr) return { valid: true, error: null, nextAt: null, text: null };
    try {
      const spec = parseCron(expr);
      const at = nextCronMatch(spec, this.now(), this.opts.timezone);
      return {
        valid: true,
        error: null,
        nextAt: at ? nowIso(this.opts.timezone, at) : null,
        text: describeCron(spec),
      };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error), nextAt: null, text: null };
    }
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
      ttlDays: entry.ttlDays,
      expiresAt: entry.expiresAt,
      expired: isExpired(entry, this.now()),
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

  /** 模型自己动作的回声（记下/修订/取用/归档/删除）：默认静音，只有 eventLevel='normal' 才发。 */
  private async emitTool(type: InkEventType, text: string): Promise<void> {
    if (this.opts.cfg.eventLevel !== 'normal') return;
    await this.emit(type, text);
  }

  private entryLine(index: number, entry: MemoryEntry): string {
    const expired = isExpired(entry, this.now());
    const flags = [KIND_LABELS[entry.kind], `重要度 ${entry.importance}`];
    if (expired) flags.push('⏳ 已过期');
    if (entry.pinned) flags.push('置顶');
    if (entry.archived) flags.push('已归档');
    const tags = entry.tags.length ? ` · #${entry.tags.join(' #')}` : '';
    return `${index}. ${entry.id}（${flags.join(' · ')}${tags}）\n   ${truncate(entry.text, PREVIEW_CHARS * 2)}`;
  }

  private entryBlock(entry: MemoryEntry): string {
    const expired = isExpired(entry, this.now());
    const flags = [KIND_LABELS[entry.kind], `重要度 ${entry.importance}`];
    if (expired) flags.push('⏳ 已过期，待整理');
    if (entry.pinned) flags.push('置顶');
    if (entry.archived) flags.push(`已归档：${entry.archiveReason ?? '未写原因'}`);
    const lines = [`【${entry.id}】${flags.join(' · ')}`, `正文：${entry.text}`];
    if (entry.tags.length) lines.push(`标签：#${entry.tags.join(' #')}`);
    if (entry.source) lines.push(`来源：${entry.source}`);
    lines.push(
      entry.ttlDays > 0 && entry.expiresAt
        ? `有效期 ${entry.ttlDays} 天（${entry.expiresAt.slice(0, 10)} 到期）。`
        : '不设时效（永久）。',
    );
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

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 相似度阈值夹在 0.5–0.99：再低会误伤「主题相近」，再高等于只抓完全一样。 */
function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.99, Math.max(0.5, n));
}

/** 面板里展示检索计划用。 */
function describePlanText(plan: ReturnType<typeof planQuery>): string {
  if (!plan.latin.length && !plan.cjk.length) return '（没有检索词）';
  const parts: string[] = [];
  if (plan.latin.length) parts.push(`词 ${plan.latin.join('、')}`);
  if (plan.cjk.length) parts.push(`中文 ${plan.cjk.map((unit) => unit.phrase).join('、')}`);
  return parts.join(' · ');
}
