/**
 * 记忆库的落盘层：一份 JSON、懒加载、写入即保存。
 *
 * 关键约定：
 * - 存档路径固定 `<dataDir>/thepalestink/entries.json`；删它就是清空记忆库。
 * - 坏档不静默丢：改名成 `entries.json.broken-<时间戳>` 后从空库继续，`recovery()` 报告路径。
 * - `maxEntries` 只数「未归档」的条目；超限时淘汰最久没被取用的未置顶条目，
 *   被淘汰的进归档（归档最多留 `ARCHIVE_KEEP` 条，再多才真正删除）。
 * - 所有写操作都会立刻落盘：进程被杀不至于丢掉刚记下的一条。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MOOD,
  KIND_LABELS,
  MAX_TTL_DAYS,
  MEMORY_SCHEMA,
  isExpired,
  isMemoryKind,
  isMemoryMood,
  type MemoryCounts,
  type MemoryDatabaseFile,
  type MemoryEntry,
  type MemoryKind,
  type MemoryMood,
  type MoodCount,
  type TagCount,
} from './types.ts';
import { clampInt, collapse, newId, nowIso, truncate } from './util.ts';

/** 正文上限。超过就拒收，让模型拆条写。 */
export const MAX_TEXT_LENGTH = 2000;
/** 一条记忆的标签上限。 */
export const MAX_TAGS = 12;
/** 单个标签的字数上限。 */
export const MAX_TAG_LENGTH = 24;
/** 来源字段的字数上限。 */
export const MAX_SOURCE_LENGTH = 80;
/** 归档区最多留多少条（超出后才真正删除）。 */
export const ARCHIVE_KEEP = 200;
/** 容量上限的默认值，与 config.ts 的 defaults 保持一致。 */
export const DEFAULT_MAX_ENTRIES = 500;
/** 容量上限的硬边界。 */
export const MAX_ENTRIES_LIMIT = 100000;
/** 一天有多少毫秒。 */
const DAY_MS = 86_400_000;

export interface MemoryStoreOptions {
  /** 宿主给的 World 共用数据目录。 */
  dataDir: string;
  /** 部署时区，用来给时间戳补偏移。 */
  timezone: string;
  /** 未归档条目的上限。 */
  maxEntries: number;
}

export interface AddMemoryInput {
  text: string;
  kind?: MemoryKind;
  mood?: MemoryMood;
  tags?: string[];
  source?: string;
  importance?: number;
  pinned?: boolean;
  /** 没给重要度时的默认值（来自配置）。 */
  defaultImportance?: number;
  /** 大概有效多少天；0 或省略 = 不过期，上限 MAX_TTL_DAYS。 */
  expiresInDays?: number;
}

export interface AddMemoryResult {
  entry: MemoryEntry;
  /** 因为容量上限被挤进归档的条目。 */
  evicted: MemoryEntry[];
}

export interface UpdateMemoryInput {
  text?: string;
  kind?: MemoryKind;
  mood?: MemoryMood;
  tags?: string[];
  source?: string;
  importance?: number;
  pinned?: boolean;
  /** 改有效期：0 = 取消时效；给了才重算 `expiresAt`。 */
  expiresInDays?: number;
}

export class MemoryStore {
  /** 存档文件的绝对路径；`ink_stats` 会把它报给模型。 */
  readonly file: string;
  private readonly dataDir: string;
  private readonly timezone: string;
  private maxEntries: number;
  private entries: MemoryEntry[] | null = null;
  private recoveredFrom: string | null = null;

  constructor(opts: MemoryStoreOptions) {
    this.dataDir = opts.dataDir;
    this.timezone = opts.timezone;
    this.maxEntries = clampInt(opts.maxEntries, 1, MAX_ENTRIES_LIMIT, DEFAULT_MAX_ENTRIES);
    this.file = join(this.dataDir, 'thepalestink', 'entries.json');
  }

  /** 坏档被改名备份后的路径；没坏过为 null。 */
  recovery(): string | null {
    this.ensureLoaded();
    return this.recoveredFrom;
  }

  /** 当前容量上限。 */
  limit(): number {
    return this.maxEntries;
  }

  /** 改容量上限；返回被挤进归档的条目。 */
  setMaxEntries(value: unknown): MemoryEntry[] {
    this.ensureLoaded();
    const next = clampInt(value, 1, MAX_ENTRIES_LIMIT, this.maxEntries);
    if (next === this.maxEntries) return [];
    this.maxEntries = next;
    const evicted = this.enforceLimit();
    this.save();
    return evicted;
  }

  /** 全部条目（含归档）。返回副本，调用方改不到存档。 */
  all(): MemoryEntry[] {
    this.ensureLoaded();
    return this.current().map((entry) => ({ ...entry, tags: [...entry.tags] }));
  }

  /** 未归档的条目。 */
  live(): MemoryEntry[] {
    return this.all().filter((entry) => !entry.archived);
  }

  /** 按 id 找；先精确、再忽略大小写。 */
  get(id: unknown): MemoryEntry | undefined {
    this.ensureLoaded();
    if (typeof id !== 'string') return undefined;
    const key = id.trim();
    if (!key) return undefined;
    const entries = this.current();
    const hit = entries.find((entry) => entry.id === key) ?? entries.find((entry) => entry.id.toLowerCase() === key.toLowerCase());
    return hit ? { ...hit, tags: [...hit.tags] } : undefined;
  }

  counts(): MemoryCounts {
    this.ensureLoaded();
    let live = 0;
    let pinned = 0;
    let archived = 0;
    for (const entry of this.current()) {
      if (entry.archived) archived += 1;
      else live += 1;
      if (entry.pinned && !entry.archived) pinned += 1;
    }
    return { live, archived, pinned, total: this.current().length };
  }

  /** 未归档条目按种类清点。 */
  byKind(): Record<MemoryKind, number> {
    const out = { fact: 0, event: 0, preference: 0, todo: 0, note: 0 } as Record<MemoryKind, number>;
    for (const entry of this.live()) out[entry.kind] += 1;
    return out;
  }

  /** 未归档条目里出现最多的标签。 */
  topTags(limit = 5): TagCount[] {
    const counts = new Map<string, number>();
    for (const entry of this.live()) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, Math.max(0, limit));
  }

  /** 被取用次数最多的条目。 */
  mostRecalled(limit = 3): MemoryEntry[] {
    return this.live()
      .filter((entry) => entry.recallCount > 0)
      .sort((a, b) => b.recallCount - a.recallCount || (b.lastRecalledAt ?? '').localeCompare(a.lastRecalledAt ?? ''))
      .slice(0, Math.max(0, limit));
  }

  /** 已过期、但还没被处理的条目（按到期时间从早到晚）。仍然算「未归档」。 */
  expired(now: Date | number = new Date()): MemoryEntry[] {
    return this.live()
      .filter((entry) => isExpired(entry, now))
      .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.id.localeCompare(b.id));
  }

  /** 已过期的未归档条目数。 */
  expiredCount(now: Date | number = new Date()): number {
    return this.live().filter((entry) => isExpired(entry, now)).length;
  }

  /** 未归档条目按情绪清点，多的在前。 */
  byMood(): MoodCount[] {
    const tally = new Map<MemoryMood, number>();
    for (const entry of this.live()) tally.set(entry.mood, (tally.get(entry.mood) ?? 0) + 1);
    return [...tally.entries()]
      .map(([mood, count]) => ({ mood, count }))
      .sort((a, b) => b.count - a.count || a.mood.localeCompare(b.mood));
  }

  add(input: AddMemoryInput): AddMemoryResult {
    this.ensureLoaded();
    const text = this.cleanText(input.text, true);
    const kind = input.kind ?? 'note';
    if (!isMemoryKind(kind)) throw new Error(`未知的种类「${String(kind)}」；可用：${MEMORY_KINDS_TEXT()}。`);
    const at = new Date();
    const now = nowIso(this.timezone, at);
    const ttlDays = clampInt(input.expiresInDays, 0, MAX_TTL_DAYS, 0);
    const entry: MemoryEntry = {
      id: newId(),
      text,
      kind,
      mood: isMemoryMood(input.mood) ? input.mood : DEFAULT_MOOD,
      tags: this.cleanTags(input.tags),
      source: this.cleanSource(input.source),
      importance: clampInt(input.importance, 0, 5, clampInt(input.defaultImportance, 0, 5, 2)),
      createdAt: now,
      updatedAt: now,
      pinned: input.pinned === true,
      archived: false,
      recallCount: 0,
      ttlDays,
      expiresAt: ttlDays > 0 ? nowIso(this.timezone, new Date(at.getTime() + ttlDays * DAY_MS)) : null,
    };
    this.current().push(entry);
    const evicted = this.enforceLimit();
    this.save();
    return { entry: { ...entry, tags: [...entry.tags] }, evicted };
  }

  /** 改一条；找不到返回 null。 */
  update(id: unknown, patch: UpdateMemoryInput): MemoryEntry | null {
    this.ensureLoaded();
    const found = this.findMutable(id);
    if (!found) return null;
    if (patch.text !== undefined) found.text = this.cleanText(patch.text, true);
    if (patch.kind !== undefined) {
      if (!isMemoryKind(patch.kind)) throw new Error(`未知的种类「${String(patch.kind)}」；可用：${MEMORY_KINDS_TEXT()}。`);
      found.kind = patch.kind;
    }
    if (patch.mood !== undefined) found.mood = isMemoryMood(patch.mood) ? patch.mood : DEFAULT_MOOD;
    if (patch.tags !== undefined) found.tags = this.cleanTags(patch.tags);
    if (patch.source !== undefined) found.source = this.cleanSource(patch.source);
    if (patch.importance !== undefined) found.importance = clampInt(patch.importance, 0, 5, found.importance);
    if (patch.pinned !== undefined) found.pinned = patch.pinned === true;
    const at = new Date();
    if (patch.expiresInDays !== undefined) {
      found.ttlDays = clampInt(patch.expiresInDays, 0, MAX_TTL_DAYS, 0);
      found.expiresAt = found.ttlDays > 0 ? nowIso(this.timezone, new Date(at.getTime() + found.ttlDays * DAY_MS)) : null;
    }
    found.updatedAt = nowIso(this.timezone, at);
    this.save();
    return { ...found, tags: [...found.tags] };
  }

  /** 记一次取用；找不到返回 null。 */
  recall(id: unknown): MemoryEntry | null {
    this.ensureLoaded();
    const found = this.findMutable(id);
    if (!found) return null;
    found.recallCount += 1;
    found.lastRecalledAt = nowIso(this.timezone);
    this.save();
    return { ...found, tags: [...found.tags] };
  }

  /** 归档（幂等）；找不到返回 null。 */
  archive(id: unknown, reason?: string): MemoryEntry | null {
    this.ensureLoaded();
    const found = this.findMutable(id);
    if (!found) return null;
    if (found.archived) return { ...found, tags: [...found.tags] };
    found.archived = true;
    found.archiveReason = collapse(reason ?? '') || '手动归档';
    found.updatedAt = nowIso(this.timezone);
    this.trimArchived();
    this.save();
    return { ...found, tags: [...found.tags] };
  }

  /** 物理删除，不可恢复；找不到返回 null。 */
  purge(id: unknown): MemoryEntry | null {
    this.ensureLoaded();
    if (typeof id !== 'string') return null;
    const key = id.trim();
    const index = this.current().findIndex((entry) => entry.id === key || entry.id.toLowerCase() === key.toLowerCase());
    if (index < 0) return null;
    const [removed] = this.current().splice(index, 1);
    this.save();
    return { ...removed, tags: [...removed.tags] };
  }

  /**
   * 把快照里的一条并进来（导入用）：保留原 id 与时间，只保证字段合法。
   * 同 id 已存在时原样返回旧条目，不覆盖——合并策略是「本地优先」。
   */
  adopt(raw: unknown): MemoryEntry | null {
    this.ensureLoaded();
    const entry = this.coerceEntry(raw);
    if (!entry) return null;
    const existing = this.findMutable(entry.id);
    if (existing) return { ...existing, tags: [...existing.tags] };
    this.current().push(entry);
    this.enforceLimit();
    this.save();
    return { ...entry, tags: [...entry.tags] };
  }

  /** 整库替换（导入 replace）：只留下能补齐成合法条目的那些；返回实际条数。 */
  replaceAll(list: readonly unknown[]): number {
    this.ensureLoaded();
    const next: MemoryEntry[] = [];
    for (const item of list) {
      const entry = this.coerceEntry(item);
      if (entry) next.push(entry);
    }
    this.entries = next;
    this.enforceLimit();
    this.save();
    return next.length;
  }

  /** 写盘前备份：复制一份 `entries.json.bak-<时间戳>`；还没有存档时返回 null。 */
  backup(): string | null {
    this.ensureLoaded();
    if (!existsSync(this.file)) return null;
    const path = `${this.file}.bak-${Date.now().toString(36)}`;
    copyFileSync(this.file, path);
    return path;
  }

  /** 存档文件当前多大（字节）；没有存档时为 0。 */
  bytes(): number {
    try {
      return existsSync(this.file) ? statSync(this.file).size : 0;
    } catch {
      return 0;
    }
  }

  /** 懒加载后的条目数组；`ensureLoaded()` 之后必然存在。 */
  private current(): MemoryEntry[] {
    this.ensureLoaded();
    if (!this.entries) throw new Error('记忆库未能加载。');
    return this.entries;
  }

  private ensureLoaded(): void {
    if (this.entries) return;
    const dir = join(this.dataDir, 'thepalestink');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(this.file)) {
      this.entries = [];
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      throw new Error(`读不到存档 ${this.file}：${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.recover();
      return;
    }
    const list = (parsed as Partial<MemoryDatabaseFile> | null)?.entries;
    if (!Array.isArray(list)) {
      this.recover();
      return;
    }
    this.entries = list.map((item) => this.coerceEntry(item)).filter((item): item is MemoryEntry => item !== null);
  }

  private recover(): void {
    const stamp = Date.now().toString(36);
    const broken = `${this.file}.broken-${stamp}`;
    try {
      renameSync(this.file, broken);
      this.recoveredFrom = broken;
    } catch {
      // 改名也失败时只能从空库起步；下一次写入会覆盖原文件。
      this.recoveredFrom = this.file;
    }
    this.entries = [];
  }

  /** 把盘上的一条补齐成合法条目；缺 id 或正文的条目丢弃。 */
  private coerceEntry(raw: unknown): MemoryEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<MemoryEntry> & Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const text = typeof item.text === 'string' ? collapse(item.text) : '';
    if (!id || !text) return null;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : nowIso(this.timezone);
    const ttlDays = clampInt(item.ttlDays, 0, MAX_TTL_DAYS, 0);
    const createdAtMs = Date.parse(createdAt);
    const expiresAt =
      typeof item.expiresAt === 'string' && item.expiresAt
        ? item.expiresAt
        : ttlDays > 0 && Number.isFinite(createdAtMs)
          ? nowIso(this.timezone, new Date(createdAtMs + ttlDays * DAY_MS))
          : null;
    return {
      id,
      text,
      kind: isMemoryKind(item.kind) ? item.kind : 'note',
      mood: isMemoryMood(item.mood) ? item.mood : DEFAULT_MOOD,
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => collapse(tag))
        : [],
      source: typeof item.source === 'string' ? item.source : '',
      importance: clampInt(item.importance, 0, 5, 2),
      createdAt,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
      pinned: item.pinned === true,
      archived: item.archived === true,
      ...(typeof item.archiveReason === 'string' && item.archiveReason ? { archiveReason: item.archiveReason } : {}),
      recallCount: clampInt(item.recallCount, 0, Number.MAX_SAFE_INTEGER, 0),
      ...(typeof item.lastRecalledAt === 'string' ? { lastRecalledAt: item.lastRecalledAt } : {}),
      ttlDays,
      expiresAt,
    };
  }

  private findMutable(id: unknown): MemoryEntry | undefined {
    if (typeof id !== 'string') return undefined;
    const key = id.trim();
    if (!key) return undefined;
    return this.entries?.find((entry) => entry.id === key) ?? this.entries?.find((entry) => entry.id.toLowerCase() === key.toLowerCase());
  }

  /** 把超出容量上限的未置顶条目挤进归档。 */
  private enforceLimit(): MemoryEntry[] {
    if (!this.entries) return [];
    const live = this.entries.filter((entry) => !entry.archived);
    if (live.length <= this.maxEntries) return [];
    const excess = live.length - this.maxEntries;
    const victims = live
      .filter((entry) => !entry.pinned)
      .sort((a, b) => recencyKey(a).localeCompare(recencyKey(b)) || a.id.localeCompare(b.id))
      .slice(0, excess);
    const now = nowIso(this.timezone);
    for (const victim of victims) {
      victim.archived = true;
      victim.archiveReason = `容量淘汰（超过 ${this.maxEntries} 条上限）`;
      victim.updatedAt = now;
    }
    this.trimArchived();
    return victims.map((entry) => ({ ...entry, tags: [...entry.tags] }));
  }

  /** 归档区只留最近的 `ARCHIVE_KEEP` 条，再老的真正删除。 */
  private trimArchived(): void {
    if (!this.entries) return;
    const archived = this.entries.filter((entry) => entry.archived && !entry.pinned);
    if (archived.length <= ARCHIVE_KEEP) return;
    const drop = new Set(
      archived
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .slice(ARCHIVE_KEEP)
        .map((entry) => entry.id),
    );
    this.entries = this.entries.filter((entry) => !drop.has(entry.id));
  }

  private save(): void {
    if (!this.entries) return;
    const payload: MemoryDatabaseFile = {
      schema: MEMORY_SCHEMA,
      updatedAt: nowIso(this.timezone),
      entries: this.entries,
    };
    const dir = join(this.dataDir, 'thepalestink');
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  private cleanText(text: unknown, required: boolean): string {
    const raw = typeof text === 'string' ? collapse(text) : '';
    if (!raw) {
      if (required) throw new Error('正文不能为空。');
      return '';
    }
    const length = [...raw].length;
    if (length > MAX_TEXT_LENGTH) {
      throw new Error(`正文 ${length} 字，超过 ${MAX_TEXT_LENGTH} 字上限。请拆成几条写，或删掉重复的细节。`);
    }
    return raw;
  }

  private cleanTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const out: string[] = [];
    for (const value of tags) {
      if (typeof value !== 'string') continue;
      const tag = collapse(value).replace(/^#+/, '');
      if (!tag) continue;
      if ([...tag].length > MAX_TAG_LENGTH) {
        throw new Error(`标签「${truncate(tag, 12)}」超过 ${MAX_TAG_LENGTH} 字。`);
      }
      if (!out.includes(tag)) out.push(tag);
      if (out.length > MAX_TAGS) throw new Error(`一条记忆最多 ${MAX_TAGS} 个标签。`);
    }
    return out;
  }

  private cleanSource(source: unknown): string {
    const raw = typeof source === 'string' ? collapse(source) : '';
    return [...raw].length > MAX_SOURCE_LENGTH ? truncate(raw, MAX_SOURCE_LENGTH) : raw;
  }
}

function recencyKey(entry: MemoryEntry): string {
  return entry.lastRecalledAt ?? entry.updatedAt;
}

function MEMORY_KINDS_TEXT(): string {
  return (Object.keys(KIND_LABELS) as MemoryKind[]).map((kind) => `${kind}（${KIND_LABELS[kind]}）`).join('、');
}
