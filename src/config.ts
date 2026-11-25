/**
 * 配置段 `worlds.thepalestink.*`。
 *
 * 全部标了 `x-hot: true`：改完不用重启，下一次工具调用就按新值走。
 * 容量上限改动会立刻触发淘汰（把最久没被取用的条目挤进归档），这一点写在控件说明里。
 *
 * 嵌入模型那一段刻意把「密钥」与「密钥名字」分开：配置里只放环境变量名，
 * 真正的密钥经 `ctx.storeSecret()` 写进部署 `.env`，不落 config.json、不进日志。
 */

import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { DEFAULT_MAX_ENTRIES, MAX_ENTRIES_LIMIT } from './store.ts';

/** 嵌入接口协议；两种都只需要 baseUrl + model。 */
export const EMBED_PROTOCOLS = ['openai', 'ollama'] as const;
export type EmbedProtocol = (typeof EMBED_PROTOCOLS)[number];

/** 默认的密钥环境变量名。 */
export const DEFAULT_SECRET_NAME = 'THEPALESTINK_EMBED_KEY';

export interface InkConfigSection {
  enabled: boolean;
  /** 未归档条目的上限；超限时淘汰最久没被取用的未置顶条目。 */
  maxEntries: number;
  /** 没写 limit 时检索返回几条。 */
  searchLimit: number;
  /** 没写 importance 时记成几。 */
  defaultImportance: number;
  /** 允许 ink_forget 带 purge=true 真正删除。 */
  hardDeleteOnForget: boolean;

  /** 事件档位：quiet 只发系统事件，normal 连每条写入/取用/归档也发。 */
  eventLevel: 'quiet' | 'normal';
  /** 写入前查重：warn 只提示不写，merge 并入旧条目，off 不查。 */
  dedupeMode: 'warn' | 'merge' | 'off';
  /** 查重的 Jaccard 阈值（0.5–0.99）。 */
  dedupeThreshold: number;

  /** 打开语义检索；关闭或调用失败时退回字面检索。 */
  semanticEnabled: boolean;
  /** `openai` = OpenAI 兼容的 /v1/embeddings；`ollama` = Ollama 的 /api/embed。 */
  embedProtocol: EmbedProtocol;
  /** 接口根地址，例如 `https://api.openai.com/v1` 或 `http://127.0.0.1:11434`。 */
  embedBaseUrl: string;
  /** 模型名，例如 `text-embedding-3-small` 或 `nomic-embed-text`。 */
  embedModel: string;
  /** 期望维度；0 = 跟随模型返回的第一条向量。 */
  embedDimensions: number;
  /** 存放 API 密钥的环境变量名；密钥本身经部署 .env 保存。 */
  embedApiKeySecret: string;
  /** 语义分在总分里的权重（0–1），越大越偏「意思」而不是字面。 */
  semanticWeight: number;

  /** 一次请求带几条文本。 */
  embedBatchSize: number;
  /** 单次请求超时（毫秒）。 */
  embedTimeoutMs: number;
  /** 同时在飞的请求数；本地模型建议 1。 */
  embedConcurrency: number;
  /** 限流：每分钟最多多少次请求。 */
  embedRequestsPerMinute: number;
  /** 429 / 5xx / 网络错误时的重试次数。 */
  embedMaxRetries: number;
  /** 每天最多多少次嵌入请求；0 = 不限制。 */
  embedDailyBudget: number;
  /** 换模型或首次启用后自动给旧条目补向量。 */
  embedAutoReindex: boolean;

  /** 定时提醒写记忆的 cron（分 时 日 月 周）；空串 = 不提醒。 */
  writeCron: string;
  /** 定时提醒时追加的一句话；空串 = 只用默认措辞。 */
  writeCronNote: string;
  /** 上下文用到窗口的百分之几时提醒写记忆；0 = 不提醒。 */
  contextReminderPercent: number;
  /** 两次上下文提醒之间至少隔多少分钟。 */
  contextReminderCooldownMinutes: number;
  /** 上下文交接完成后提醒补写。 */
  handoffReminder: boolean;

  /** 是否自动归档低价值条目。 */
  autoArchiveEnabled: boolean;
  /** 多少天没被取用算「久远」。 */
  autoArchiveAgeDays: number;
  /** 重要度不高于几分才算「不重要」。 */
  autoArchiveImportance: number;
  /** 是否自动归档重复/冲突的旧条目。 */
  autoArchiveConflicts: boolean;
  /** 相似度达到多少算「几乎重复」。 */
  conflictSimilarity: number;
  /** 两次自动归档检查之间至少隔多少分钟。 */
  maintenanceIntervalMinutes: number;
}

export const INK_DEFAULTS: InkConfigSection = {
  // 定义里恒为 false：装不装、开不开由 bot 的声明与部署决定（宿主 dryMount 的约定）。
  enabled: false,
  maxEntries: DEFAULT_MAX_ENTRIES,
  searchLimit: 8,
  defaultImportance: 2,
  hardDeleteOnForget: false,

  // 事件默认静音：写入/取用/归档的回声对模型没信息量，只留系统级事件。
  eventLevel: 'quiet',
  dedupeMode: 'warn',
  dedupeThreshold: 0.82,

  semanticEnabled: false,
  embedProtocol: 'openai',
  embedBaseUrl: 'https://api.openai.com/v1',
  embedModel: 'text-embedding-3-small',
  embedDimensions: 0,
  embedApiKeySecret: DEFAULT_SECRET_NAME,
  semanticWeight: 0.45,

  embedBatchSize: 16,
  embedTimeoutMs: 20_000,
  embedConcurrency: 1,
  embedRequestsPerMinute: 60,
  embedMaxRetries: 2,
  embedDailyBudget: 2000,
  embedAutoReindex: true,

  // 默认不按钟点提醒：几点该写记忆是人的作息，不该由包替人定。
  writeCron: '',
  writeCronNote: '',
  contextReminderPercent: 75,
  contextReminderCooldownMinutes: 60,
  handoffReminder: true,

  autoArchiveEnabled: true,
  autoArchiveAgeDays: 30,
  autoArchiveImportance: 1,
  autoArchiveConflicts: true,
  conflictSimilarity: 0.82,
  maintenanceIntervalMinutes: 60,
};

export const INK_CONFIG_GROUP: ConfigGroup = {
  id: 'world:thepalestink',
  owner: 'world:thepalestink',
  schema: {
    type: 'object',
    title: '淡墨 · 记忆库',
    description:
      '记忆条目存在 <dataDir>/thepalestink/entries.json；容量超限时自动淘汰最久没被取用的条目。嵌入模型的日常配置建议走「淡墨」页的嵌入向导，这里改也立即生效。',
    properties: {
      'worlds.thepalestink.maxEntries': {
        type: 'integer',
        title: '容量上限（条）',
        description: `未归档条目最多几条。超过后淘汰最久没被取用、且未置顶的条目（进归档，不直接消失）。范围 1–${MAX_ENTRIES_LIMIT}。改小会立刻淘汰。`,
        minimum: 1,
        maximum: MAX_ENTRIES_LIMIT,
        'x-hot': true,
      },
      'worlds.thepalestink.searchLimit': {
        type: 'integer',
        title: '默认检索条数',
        description: 'ink_search / ink_list 没写 limit 时返回几条。范围 1–50。',
        minimum: 1,
        maximum: 50,
        'x-hot': true,
      },
      'worlds.thepalestink.defaultImportance': {
        type: 'integer',
        title: '默认重要度',
        description: '写入时没给 importance 的条目记成 0–5 之间的几分；检索排序会用到。',
        minimum: 0,
        maximum: 5,
        'x-hot': true,
      },
      'worlds.thepalestink.hardDeleteOnForget': {
        type: 'boolean',
        title: '允许真正删除',
        description: '关着时 ink_forget 只能归档；打开后才允许 purge=true 物理删除条目，删了不可恢复。',
        'x-hot': true,
      },
      'worlds.thepalestink.eventLevel': {
        type: 'string',
        title: '事件档位',
        description:
          'quiet（默认）= 只发加载、提醒、嵌入、容量淘汰、自动整理这些系统事件；normal = 连每条「记下/修订/取用/归档/删除」也发。模型自己动作的回声用处不大，但时间线上看得到全过程。',
        enum: ['quiet', 'normal'],
        'x-hot': true,
      },
      'worlds.thepalestink.dedupeMode': {
        type: 'string',
        title: '写入查重',
        description:
          'warn（默认）= 发现几乎重复就不写，回执里给旧 id 与相似度，模型可用 ink_amend 改旧的或带 force 坚持写；merge = 自动把新正文并到旧条目末尾；off = 不查重。',
        enum: ['warn', 'merge', 'off'],
        'x-hot': true,
      },
      'worlds.thepalestink.dedupeThreshold': {
        type: 'number',
        title: '查重阈值',
        description: '特征重合度到多少算「几乎重复」（0.5–0.99）。调低会拦下更多「主题相近」的新条目，调高只拦几乎逐字相同的。',
        minimum: 0.5,
        maximum: 0.99,
        multipleOf: 0.01,
        'x-hot': true,
      },

      'worlds.thepalestink.semanticEnabled': {
        type: 'boolean',
        title: '语义检索',
        description:
          '打开后，检索除了字面命中，还会用嵌入模型比较「意思相近」。嵌入不可用（没配、超时、限流）时自动退回字面检索，不会让 ink_search 失败。',
        'x-hot': true,
      },
      'worlds.thepalestink.embedProtocol': {
        type: 'string',
        title: '嵌入接口协议',
        description:
          'openai = 任何 OpenAI 兼容的 /v1/embeddings（OpenAI、LM Studio、vLLM、OpenRouter…）；ollama = Ollama 原生 /api/embed。',
        enum: [...EMBED_PROTOCOLS],
        'x-hot': true,
      },
      'worlds.thepalestink.embedBaseUrl': {
        type: 'string',
        title: '嵌入接口地址',
        description:
          'OpenAI 兼容：到 /v1 为止，如 https://api.openai.com/v1、http://127.0.0.1:1234/v1；Ollama：到端口为止，如 http://127.0.0.1:11434。',
        'x-hot': true,
      },
      'worlds.thepalestink.embedModel': {
        type: 'string',
        title: '嵌入模型',
        description: '如 text-embedding-3-small（OpenAI）、nomic-embed-text（Ollama）、text-embedding-nomic-embed-text-v1.5（LM Studio）。',
        'x-hot': true,
      },
      'worlds.thepalestink.embedDimensions': {
        type: 'integer',
        title: '向量维度',
        description: '0 = 跟随模型返回。填了就必须与模型输出一致，否则拒绝入库；换维度等于换空间，会自动重建全部向量。',
        minimum: 0,
        maximum: 8192,
        'x-hot': true,
      },
      'worlds.thepalestink.embedApiKeySecret': {
        type: 'string',
        title: '密钥所在的环境变量名',
        description:
          '默认 THEPALESTINK_EMBED_KEY。这里只写名字；密钥在「淡墨」页的嵌入向导里填，写进部署 .env，不落 config.json。本地模型可以留空。',
        'x-hot': true,
      },
      'worlds.thepalestink.semanticWeight': {
        type: 'number',
        title: '语义权重',
        description: '0–1。越大越偏「意思相近」，越小越偏字面命中。建议 0.3–0.6。',
        minimum: 0,
        maximum: 1,
        'x-hot': true,
      },

      'worlds.thepalestink.embedBatchSize': {
        type: 'integer',
        title: '批量大小',
        description: '一次请求带几条文本（补向量时用）。本地小模型建议 8–16。',
        minimum: 1,
        maximum: 64,
        'x-hot': true,
      },
      'worlds.thepalestink.embedTimeoutMs': {
        type: 'integer',
        title: '请求超时（毫秒）',
        description: '单次嵌入请求的超时；超时按失败计，检索退回字面模式。',
        minimum: 1000,
        maximum: 120000,
        'x-hot': true,
      },
      'worlds.thepalestink.embedConcurrency': {
        type: 'integer',
        title: '并发请求数',
        description: '同时在飞的嵌入请求数。免费额度或本地模型建议 1；云端付费可到 2–4。',
        minimum: 1,
        maximum: 8,
        'x-hot': true,
      },
      'worlds.thepalestink.embedRequestsPerMinute': {
        type: 'integer',
        title: '每分钟请求上限',
        description: '限流用。每个嵌入请求（一批）算一次；超过就排队等，未配置的重试不会打破它。',
        minimum: 6,
        maximum: 6000,
        'x-hot': true,
      },
      'worlds.thepalestink.embedMaxRetries': {
        type: 'integer',
        title: '失败重试次数',
        description: '遇到 429、5xx 或网络错误时的重试次数；按指数退避，尊重 Retry-After。',
        minimum: 0,
        maximum: 5,
        'x-hot': true,
      },
      'worlds.thepalestink.embedDailyBudget': {
        type: 'integer',
        title: '每日请求预算',
        description: '每天最多多少次嵌入请求，用来兜底防止烧额度；0 = 不限制。用超后语义检索自动退回字面模式。',
        minimum: 0,
        maximum: 100000,
        'x-hot': true,
      },
      'worlds.thepalestink.embedAutoReindex': {
        type: 'boolean',
        title: '自动补向量',
        description: '首次启用或换模型后，启动时自动给未向量化的条目补上（受批量、限流与每日预算约束）。',
        'x-hot': true,
      },
    },
  },
};

/**
 * 第二组配置：什么时候提醒写、什么时候自动归档。
 *
 * 与上面那组分开，是因为它回答的是「节奏」而不是「容量与模型」，
 * 放在同一张卡里会让人以为提醒是存储的一部分。
 */
export const INK_RHYTHM_CONFIG_GROUP: ConfigGroup = {
  id: 'world:thepalestink.rhythm',
  owner: 'world:thepalestink',
  schema: {
    type: 'object',
    title: '淡墨 · 写记忆的节奏',
    description:
      '提醒是「推一条事件给模型」：它会在下一批看到，然后自己决定写什么。这里不替模型写记忆，也不要求它每次都写。时间按部署时区理解。',
    properties: {
      'worlds.thepalestink.writeCron': {
        type: 'string',
        title: '定时提醒（cron）',
        description: '五段：分 时 日 月 周，例如 30 7 * * *（每天 07:30）。留空表示不按钟点提醒。',
        'x-hot': true,
      },
      'worlds.thepalestink.writeCronNote': {
        type: 'string',
        title: '定时提醒追加的话',
        description: '每次到点会附在提醒后面，例如「顺便看一眼今天的待办」。留空只用默认措辞。',
        'x-hot': true,
      },
      'worlds.thepalestink.contextReminderPercent': {
        type: 'integer',
        title: '上下文阈值（%）',
        description:
          '估到上下文窗口用了几成时提醒写记忆；0 = 不提醒。估算按「中日韩一字一 token、其余 3.6 字符一 token」粗算，宁可早提醒。',
        minimum: 0,
        maximum: 95,
        'x-hot': true,
      },
      'worlds.thepalestink.contextReminderCooldownMinutes': {
        type: 'integer',
        title: '上下文提醒间隔（分钟）',
        description: '阈值提醒至少隔这么久才说一次，免得每轮都催。',
        minimum: 5,
        maximum: 1440,
        'x-hot': true,
      },
      'worlds.thepalestink.handoffReminder': {
        type: 'boolean',
        title: '交接后提醒补写',
        description: '上下文交接完成后推一条「刚丢掉细节，有遗漏现在补」。宿主没有「交接前」的钩子，所以提醒落在交接后的第一批。',
        'x-hot': true,
      },

      'worlds.thepalestink.autoArchiveEnabled': {
        type: 'boolean',
        title: '自动归档',
        description: '按下面的两条规则把低价值条目移进归档（不删除，检索加「含归档」仍能看到）。置顶与重要度 5 的条目不自动动。',
        'x-hot': true,
      },
      'worlds.thepalestink.autoArchiveAgeDays': {
        type: 'integer',
        title: '多久没动算久远（天）',
        description: '按「最近取用时间，没有则按最近修订时间」算。',
        minimum: 1,
        maximum: 3650,
        'x-hot': true,
      },
      'worlds.thepalestink.autoArchiveImportance': {
        type: 'integer',
        title: '低重要度阈值',
        description: '重要度不高于几分才可能被自动归档（0–4；5 永远不动）。',
        minimum: 0,
        maximum: 4,
        'x-hot': true,
      },
      'worlds.thepalestink.autoArchiveConflicts': {
        type: 'boolean',
        title: '归档重复/冲突条目',
        description: '同一件事记了两遍、说法还冲突时，保留较新的那条，旧的归档并写明原因。',
        'x-hot': true,
      },
      'worlds.thepalestink.conflictSimilarity': {
        type: 'number',
        title: '算重复的相似度',
        description: '按中文相邻两字、英文单词的 Jaccard 相似度；0.5–0.99。调低会误伤「主题相近」的条目，建议 0.8 以上。',
        minimum: 0.5,
        maximum: 0.99,
        multipleOf: 0.01,
        'x-hot': true,
      },
      'worlds.thepalestink.maintenanceIntervalMinutes': {
        type: 'integer',
        title: '自动归档检查间隔（分钟）',
        description: '多久检查一次；启动时也会查一次。',
        minimum: 5,
        maximum: 1440,
        'x-hot': true,
      },
    },
  },
};

/** 面板里的预设（只用于填表，不参与校验）。 */
export interface EmbedPreset {
  id: string;
  label: string;
  protocol: EmbedProtocol;
  baseUrl: string;
  model: string;
  dimensions: number;
  needsKey: boolean;
  note: string;
}

export const EMBED_PRESETS: readonly EmbedPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimensions: 0,
    needsKey: true,
    note: '需要 API 密钥；text-embedding-3-small 便宜、够用。',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'nomic-embed-text',
    dimensions: 0,
    needsKey: false,
    note: '先 `ollama pull nomic-embed-text`；不花钱，速度取决于本机。',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'text-embedding-nomic-embed-text-v1.5',
    dimensions: 0,
    needsKey: false,
    note: '在 LM Studio 里加载一个 embedding 模型并打开本地服务器；密钥留空即可。',
  },
  {
    id: 'custom',
    label: '自定义',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    dimensions: 0,
    needsKey: true,
    note: '任何 OpenAI 兼容端点（vLLM、OpenRouter、自建网关）。',
  },
];
