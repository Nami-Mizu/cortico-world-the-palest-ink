/** 面板与宿主之间的载荷类型（只在这里定义，服务端不 import 它）。 */

export type EmbedState = 'off' | 'unconfigured' | 'error' | 'ready' | 'partial';

export interface PanelCounts {
  live: number;
  archived: number;
  pinned: number;
  total: number;
}

export interface PanelEntry {
  id: string;
  text: string;
  fullLength: number;
  kind: string;
  kindLabel: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  recallCount: number;
  /** 有效期（天）；0 = 永久。 */
  ttlDays: number;
  /** 到期时刻；null = 不过期。 */
  expiresAt: string | null;
  /** 此刻是否已过期。 */
  expired: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface EmbedUsage {
  day: string;
  calls: number;
  failures: number;
  totalCalls: number;
  lastOkAt?: string;
  lastError?: string;
  budget: number;
}

export interface EmbedSummary {
  enabled: boolean;
  state: EmbedState;
  model: string;
  dims: number;
  indexed: number;
  live: number;
  storageModel: string;
  lastError: string | null;
  usage: EmbedUsage;
  vectorFile: string;
  recovery: string | null;
}

export interface EmbedPreset {
  id: string;
  label: string;
  protocol: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  needsKey: boolean;
  note: string;
}

export interface EmbedSettings {
  protocol: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKeySecret: string;
  semanticEnabled: boolean;
  semanticWeight: number;
  batchSize: number;
  timeoutMs: number;
  concurrency: number;
  requestsPerMinute: number;
  maxRetries: number;
  dailyBudget: number;
  autoReindex: boolean;
}

export interface EmbeddingStatus extends EmbedSummary {
  presets: EmbedPreset[];
  secretName: string;
  hasKey: boolean;
  settings: EmbedSettings;
  target: string;
}

export interface PanelArchiveSample {
  id: string;
  reason: string;
  kind: 'stale' | 'conflict';
}

/** 「写记忆的节奏」：提醒条件、下次到点、最近一次自动归档。 */
export interface PanelRhythm {
  cron: string;
  cronValid: boolean;
  cronError: string | null;
  cronNextAt: string | null;
  cronText: string | null;
  contextPercentLimit: number;
  contextCooldownMinutes: number;
  estimatedTokens: number;
  contextWindow: number | null;
  estimatedPercent: number | null;
  handoffReminder: boolean;
  lastReminder: { kind: 'schedule' | 'context' | 'handoff'; at: string; text: string } | null;
  maintenance: {
    enabled: boolean;
    ageDays: number;
    importance: number;
    conflicts: boolean;
    similarity: number;
    lastRunAt: string | null;
    lastArchived: number;
    totalArchived: number;
    sample: PanelArchiveSample[];
  };
}

export interface LibrarySnapshot {
  counts: PanelCounts;
  limit: number;
  kinds: Array<{ kind: string; label: string; count: number }>;
  tags: TagCount[];
  recent: PanelEntry[];
  /** 已过期、待整理的条目（只读展示，处理要由模型或人通过工具做）。 */
  expired: { count: number; items: PanelEntry[] };
  embed: EmbedSummary;
  rhythm: PanelRhythm;
  storeFile: string;
  vectorFile: string;
  recovery: string | null;
}

/** 星图上的一个点：只带画图需要的字段，不带全文。 */
export interface StarPoint {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  archived: boolean;
  expired: boolean;
  recallCount: number;
  updatedAt: string;
}

export interface StarMapResponse {
  points: StarPoint[];
  /** 当前这批点里的标签计数（最多 24 个）；布局用它的前 8 个做圈。 */
  tags: TagCount[];
  counts: { shown: number; matched: number; live: number; archived: number; total: number };
  truncated: boolean;
}

export interface SearchHit extends PanelEntry {
  score: number;
  semantic?: boolean;
  matched?: string[];
}

export interface SearchResponse {
  hits: SearchHit[];
  plan: string;
  degraded: string | null;
  semantic: boolean;
  hint?: string;
}

export interface EntryResponse {
  entry: PanelEntry;
  text: string;
  source: string;
  archiveReason: string | null;
  lastRecalledAt: string | null;
  vectorized: boolean;
}

export interface ProbeResponse {
  ok: boolean;
  dims?: number;
  ms?: number;
  error?: string;
  state: EmbedSummary;
}

export interface ReindexResponse {
  indexed: number;
  failed: number;
}

export interface SaveResponse {
  saved: string[];
  status: EmbeddingStatus;
}

export interface SecretResponse {
  saved: boolean;
  name: string;
}

/** 「数据」页的现状。 */
export interface DataStatus {
  counts: PanelCounts;
  expired: number;
  storeFile: string;
  vectorFile: string;
  entriesBytes: number;
  vectorCount: number;
  lastBackup: string | null;
  lastImportAt: string | null;
  maxImportEntries: number;
  schema: number;
}

export interface ExportResponse {
  filename: string;
  json: string;
  exported: number;
  archived: number;
  bytes: number;
  note: string;
}

/** 导入预演与执行共用的摘要。 */
export interface ImportSummary {
  mode: 'merge' | 'replace';
  incoming: number;
  added: number;
  skipped: number;
  duplicates: Array<{ id: string; of: string; similarity: number }>;
  duplicateCount: number;
  invalid: number;
  samples: Array<{ id: string; text: string }>;
  exportedAt?: string;
  local?: PanelCounts;
}

export interface ImportResponse extends ImportSummary {
  imported: number;
  backup: string | null;
  counts?: PanelCounts;
  note?: string;
}

export interface PanelResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
