/**
 * 记忆条目与存档文件的形状。
 *
 * 存档是一份纯 JSON（`<dataDir>/thepalestink/entries.json`），字段全部是基本类型：
 * 换机器、手看、diff 都容易。schema 升级时旧档要在 README 与 CHANGELOG 里点名。
 */

export const MEMORY_SCHEMA = 1;

/** 条目种类。枚举值会进工具参数，改名等于改接口。 */
export const MEMORY_KINDS = ['fact', 'event', 'preference', 'todo', 'note'] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 种类在提示词与回执里的中文说法。 */
export const KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  fact: '事实',
  event: '事件',
  preference: '偏好',
  todo: '待办',
  note: '杂记',
};

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

/** 一条记忆。 */
export interface MemoryEntry {
  id: string;
  /** 正文，1–2000 字。 */
  text: string;
  kind: MemoryKind;
  tags: string[];
  /** 来源：哪次对话、哪份文件、谁说的。空字符串表示没记。 */
  source: string;
  /** 重要度 0–5，整数。检索排序会用到。 */
  importance: number;
  /** ISO 8601 带偏移。 */
  createdAt: string;
  updatedAt: string;
  /** 置顶的条目不会被容量上限淘汰。 */
  pinned: boolean;
  /** 归档 = 不参与默认检索，但仍在存档里。 */
  archived: boolean;
  /** 归档原因（含「容量淘汰」）。 */
  archiveReason?: string;
  /** 被 ink_recall 取用的次数。 */
  recallCount: number;
  lastRecalledAt?: string;
  /** 大概有效多少天；0 = 永久。写入或改期时定下，改正文不会重置。 */
  ttlDays: number;
  /** 到期时刻（ISO 8601）；null = 不过期。到点后仍可检索，但会被标「已过期」并略降权。 */
  expiresAt: string | null;
}

/** 一条记忆的有效期上限（天）；0 表示不过期。 */
export const MAX_TTL_DAYS = 3650;

/** 一天有多少毫秒。 */
const DAY_MS = 86_400_000;

/** 这条记忆在 `now` 时刻是否已过期；没有到期时间的永远不过期。 */
export function isExpired(entry: Pick<MemoryEntry, 'expiresAt'>, now: Date | number): boolean {
  if (!entry.expiresAt) return false;
  const at = Date.parse(entry.expiresAt);
  if (!Number.isFinite(at)) return false;
  return at <= (typeof now === 'number' ? now : now.getTime());
}

/** 过期多少天（向下取整）；没过期为 0。 */
export function overdueDays(entry: Pick<MemoryEntry, 'expiresAt'>, now: Date | number): number {
  if (!entry.expiresAt) return 0;
  const at = Date.parse(entry.expiresAt);
  if (!Number.isFinite(at)) return 0;
  const ms = (typeof now === 'number' ? now : now.getTime()) - at;
  return ms > 0 ? Math.floor(ms / DAY_MS) : 0;
}

/** 存档文件的顶层结构。 */
export interface MemoryDatabaseFile {
  schema: number;
  updatedAt: string;
  entries: MemoryEntry[];
}

/** 清点结果。 */
export interface MemoryCounts {
  live: number;
  archived: number;
  pinned: number;
  total: number;
}

/** 标签榜的一项。 */
export interface TagCount {
  tag: string;
  count: number;
}
