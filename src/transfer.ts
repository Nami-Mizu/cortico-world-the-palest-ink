/**
 * 导入导出：只做纯计算，不碰文件系统。
 *
 * `world.ts` 负责「先备份、再写盘」，这里负责「这份快照是什么、导进来会发生什么」。
 * 预演（preview）与执行（import）走同一个 `planImport`，所以面板上看到的数字
 * 就是真正会写进去的数字——不会出现「预览说 3 条、导入变成 5 条」。
 *
 * 合并策略固定为「本地优先」：同 id 跳过、内容重复跳过、只补本地没有的。
 * 覆盖模式要人在面板里再输一次「替换」，且写盘前一定有备份。
 */

import type { MemoryKind } from './types.ts';
import { MEMORY_KINDS } from './types.ts';
import { findDuplicate, type DedupeCandidate } from './dedupe.ts';
import { truncate } from './util.ts';

/** 快照格式版本；只增不改，读到更高版本就拒绝，别猜。 */
export const TRANSFER_SCHEMA = 1;
/** 一次导入的上限：再多就该走别的通道了，不该让面板卡死。 */
export const MAX_IMPORT_ENTRIES = 5000;

export interface ParsedSnapshot {
  exportedAt: string;
  entries: unknown[];
}

export interface ImportPlan {
  mode: 'merge' | 'replace';
  /** 文件里一共有多少条。 */
  incoming: number;
  /** 会写进去的。 */
  added: unknown[];
  /** 同 id 已在本地（merge）或文件内重复（replace）而跳过的。 */
  skipped: number;
  /** 内容与已有条目几乎重复而跳过的。 */
  duplicates: Array<{ id: string; of: string; similarity: number }>;
  /** 缺 id 或正文、导入不了的。 */
  invalid: number;
  /** 前几条会写进去的预览。 */
  samples: Array<{ id: string; text: string }>;
}

/** 生成一份快照文件；按导出顺序原样写入。 */
export function buildSnapshot(entries: readonly unknown[], exportedAt: string): string {
  return JSON.stringify({ schema: TRANSFER_SCHEMA, app: 'thepalestink', exportedAt, entries }, null, 2);
}

/** 解析快照；坏文件给中文原因，不抛 JSON 的原始错误。 */
export function parseSnapshot(raw: string): ParsedSnapshot {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('文件是空的。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('不是合法的 JSON：确认一下是不是「导出」下的文件。');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) throw new Error('这份文件没有 entries 数组：看起来不是淡墨导出的快照。');
  if (list.length > MAX_IMPORT_ENTRIES) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_ENTRIES} 条；这份有 ${list.length} 条，请拆开导入。`);
  }
  const exportedAt =
    parsed && typeof parsed === 'object' && typeof (parsed as { exportedAt?: unknown }).exportedAt === 'string'
      ? String((parsed as { exportedAt: string }).exportedAt)
      : '';
  return { exportedAt, entries: list };
}

/**
 * 算出导入会发生什么。
 * `local` 是当前库里的条目（含归档），`incoming` 是快照里的原始 JSON。
 */
export function planImport(
  local: readonly DedupeCandidate[],
  incoming: readonly unknown[],
  options: { mode: 'merge' | 'replace'; threshold?: number },
): ImportPlan {
  const mode = options.mode === 'replace' ? 'replace' : 'merge';
  const plan: ImportPlan = { mode, incoming: incoming.length, added: [], skipped: 0, duplicates: [], invalid: 0, samples: [] };
  const seen = new Set<string>(mode === 'merge' ? local.map((entry) => entry.id.toLowerCase()) : []);
  const pool: DedupeCandidate[] = mode === 'merge' ? [...local] : [];

  for (const item of incoming) {
    const candidate = normalizeCandidate(item);
    if (!candidate) {
      plan.invalid += 1;
      continue;
    }
    const key = candidate.id.toLowerCase();
    if (seen.has(key)) {
      plan.skipped += 1;
      continue;
    }
    const match = findDuplicate(pool, candidate.text, {
      kind: candidate.kind,
      threshold: options.threshold,
    });
    if (match) {
      plan.duplicates.push({
        id: candidate.id,
        of: match.entry.id,
        similarity: Math.round(match.jaccard * 100),
      });
      seen.add(key);
      continue;
    }
    plan.added.push(item);
    seen.add(key);
    pool.push(candidate);
    if (plan.samples.length < 5) plan.samples.push({ id: candidate.id, text: truncate(candidate.text, 80) });
  }
  return plan;
}

/** 只取判断要用的字段；缺 id 或正文的不算合法条目。 */
export function normalizeCandidate(raw: unknown): DedupeCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!id || !text) return null;
  const kind = (MEMORY_KINDS as readonly string[]).includes(String(item.kind)) ? (item.kind as MemoryKind) : 'note';
  return {
    id,
    text,
    kind,
    archived: item.archived === true,
    pinned: item.pinned === true,
  };
}
