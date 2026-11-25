/**
 * 自动归档的判定：只算「该归档谁、为什么」，不动存储。
 *
 * 两条规则，都要保守：
 * 1. 长期不再被用到、且重要度低的条目——放过期不动它才是问题；
 * 2. 两条同时活着、内容几乎重复的条目——留较新的那条。
 * 置顶条目、重要度 5 的长期设定，两条规则都不碰：那是人确认过要留下的东西。
 *
 * 这里不 import 宿主，也不读写文件：`world.ts` 把结果交给 `store.archive()`，
 * `_dev/verify.mjs` 可以直接用 Node 的类型擦除跑它。
 */

import type { MemoryEntry } from './types.ts';

export interface MaintenanceSettings {
  enabled: boolean;
  /** 多少天没被取用/修订算「久远」。 */
  ageDays: number;
  /** 重要度不高于几分才算「不重要」。 */
  importance: number;
  /** 是否检查重复/冲突。 */
  conflicts: boolean;
  /** 相似度达到多少算「几乎重复」（0–1）。 */
  similarity: number;
}

export interface ArchiveDecision {
  id: string;
  /** 写进 `entry.archiveReason` 的说明。 */
  reason: string;
  kind: 'stale' | 'conflict';
}

/** 重要度 5 的条目是长期设定，两条规则都不自动动它。 */
const SACRED_IMPORTANCE = 5;

/** 两条规则的执行顺序与上限；上限只是防病态数据把一次维护拖成 O(n²)。 */
const MAX_CONFLICT_ENTRIES = 600;

/** 算出一批该归档的条目；不改输入数组。 */
export function planMaintenance(entries: readonly MemoryEntry[], settings: MaintenanceSettings, now: Date): ArchiveDecision[] {
  if (!settings.enabled) return [];
  const decisions: ArchiveDecision[] = [];
  const decided = new Set<string>();
  const nowMs = now.getTime();

  const live = entries.filter((entry) => !entry.archived);
  const stale = new Set<string>();
  for (const entry of live) {
    if (entry.pinned) continue;
    if (entry.importance > settings.importance) continue;
    const last = Date.parse(entry.lastRecalledAt ?? entry.updatedAt);
    if (!Number.isFinite(last)) continue;
    const days = Math.floor((nowMs - last) / 86_400_000);
    if (days < settings.ageDays) continue;
    stale.add(entry.id);
    decided.add(entry.id);
    decisions.push({
      id: entry.id,
      kind: 'stale',
      reason: `自动归档：${days} 天没被取用，重要度 ${entry.importance}（阈值 ${settings.importance}）`,
    });
  }

  if (!settings.conflicts) return decisions;

  const candidates = live.filter((entry) => !stale.has(entry.id) && !entry.pinned).slice(0, MAX_CONFLICT_ENTRIES);
  if (candidates.length < 2) return decisions;

  const prints = candidates.map((entry) => fingerprint(entry.text));
  for (let left = 0; left < candidates.length; left += 1) {
    const a = candidates[left]!;
    if (a.importance >= SACRED_IMPORTANCE) continue;
    for (let right = left + 1; right < candidates.length; right += 1) {
      const b = candidates[right]!;
      if (a.kind !== b.kind) continue;
      if (b.importance >= SACRED_IMPORTANCE) continue;
      if (decided.has(a.id) || decided.has(b.id)) continue;
      const score = jaccard(prints[left]!, prints[right]!);
      if (score < settings.similarity) continue;
      // 重要度低的先让；一样重要时，旧的让（新的通常是更正过的说法）。
      const loser = a.importance < b.importance ? a : b.importance < a.importance ? b : a.updatedAt <= b.updatedAt ? a : b;
      const winner = loser === a ? b : a;
      decided.add(loser.id);
      decisions.push({
        id: loser.id,
        kind: 'conflict',
        reason: `自动归档：与 ${winner.id} 内容重复（相似度 ${Math.round(score * 100)}%），保留较新的那条`,
      });
    }
  }
  return decisions;
}

/** 中文按相邻两字、拉丁按词，做成集合；用于算 Jaccard 相似度。 */
export function fingerprint(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) tokens.add(`w:${word}`);
  const cjk = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  for (const run of cjk) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.add(`c:${chars[0]}`);
      continue;
    }
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.add(`c:${chars[index]}${chars[index + 1]}`);
  }
  return tokens;
}

/** 集合交并比；任一为空返回 0。 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}
