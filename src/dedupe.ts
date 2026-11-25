/**
 * 写入前查重：simhash 当筛子，Jaccard 当法官。
 *
 * 单看一条都不稳：改一个「不」字，Jaccard 可能还在 0.8 以上，simhash 也只差两三位；
 * 换成同义说法，Jaccard 掉下去，simhash 也可能差十位。所以两把尺子一起用，
 * 任一条超线就判「像」：
 * - Jaccard ≥ threshold（默认 0.82）= 特征几乎同一组；
 * - 汉明距离 ≤ 4 位 = 64 位指纹几乎一样。
 *
 * 判到重复不是错误，是「别写第二份」的提示：调用方回执里给旧 id 与相似度，
 * 模型可以 ink_amend 改旧的，或带 force 坚持新写。这里不读写文件、不 import 宿主。
 */

import type { MemoryKind } from './types.ts';
import { fingerprint } from './maintenance.ts';

/** 特征交并比到这个数就算同一句。 */
export const DEDUPE_JACCARD = 0.82;
/** 小集合被大集合包含到这个比例也算同一句：同一件事补了后半句，Jaccard 会掉，包含度不掉。 */
export const DEDUPE_CONTAINMENT = 0.92;
/** 64 位指纹最多差几位算同一句。 */
export const DEDUPE_HAMMING = 4;
/** 特征太少时（一两个词）不判：短句撞车太常见，宁可漏判也不误拦。 */
export const MIN_FEATURES = 3;

export interface DedupeCandidate {
  id: string;
  text: string;
  kind: MemoryKind;
  archived?: boolean;
  pinned?: boolean;
}

export interface DedupeOptions {
  /** 只和同种类的条目比。 */
  kind?: MemoryKind;
  /** 覆盖默认 Jaccard 阈值。 */
  threshold?: number;
  /** 覆盖默认汉明距离上限。 */
  hamming?: number;
  /** 比较时跳过这条（改自己时用）。 */
  excludeId?: string;
}

export interface DedupeMatch<T extends DedupeCandidate = DedupeCandidate> {
  entry: T;
  /** 特征交并比（0–1）。 */
  jaccard: number;
  /** 64 位指纹的汉明距离（0–64）。 */
  hamming: number;
}

/** FNV-1a 32 位；同一段文本永远同一个值，不依赖随机种子。 */
export function hash32(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 把一组特征折成 64 位指纹：每个特征投 64 票（两位哈希拼起来），过半置 1。 */
export function simhashOf(features: Iterable<string>): bigint {
  const votes = new Int32Array(64);
  let count = 0;
  for (const feature of features) {
    const low = hash32(feature, 0x811c9dc5);
    const high = hash32(feature, 0x9e3779b9);
    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit]! += (low >>> bit) & 1 ? 1 : -1;
      votes[bit + 32]! += (high >>> bit) & 1 ? 1 : -1;
    }
    count += 1;
  }
  if (!count) return 0n;
  let value = 0n;
  for (let bit = 0; bit < 64; bit += 1) if (votes[bit]! > 0) value |= 1n << BigInt(bit);
  return value;
}

/** 文本的 64 位 simhash；空文本得 0n。 */
export function simhash64(text: string): bigint {
  return simhashOf(fingerprint(text));
}

/** 两个指纹差几位。 */
export function hamming64(left: bigint, right: bigint): number {
  let diff = left ^ right;
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * 在候选里找和新正文最像的一条；没有就返回 null。
 * 只比较未归档、未置顶、未排除、同 kind 的条目。
 */
export function findDuplicate<T extends DedupeCandidate>(
  candidates: readonly T[],
  text: string,
  options: DedupeOptions = {},
): DedupeMatch<T> | null {
  const features = fingerprint(text);
  if (features.size < MIN_FEATURES) return null;
  const threshold = clamp01(options.threshold, DEDUPE_JACCARD);
  const maxHamming = Math.max(0, Math.min(64, Math.round(options.hamming ?? DEDUPE_HAMMING)));
  const target = simhashOf(features);
  const exclude = typeof options.excludeId === 'string' ? options.excludeId.toLowerCase() : '';
  let best: DedupeMatch<T> | null = null;

  for (const candidate of candidates) {
    if (candidate.archived || candidate.pinned) continue;
    if (exclude && candidate.id.toLowerCase() === exclude) continue;
    if (options.kind && candidate.kind !== options.kind) continue;
    const prints = fingerprint(candidate.text);
    if (prints.size < MIN_FEATURES) continue;
    let shared = 0;
    for (const feature of features) if (prints.has(feature)) shared += 1;
    const union = features.size + prints.size - shared;
    const overlap = union ? shared / union : 0;
    const distance = hamming64(target, simhashOf(prints));
    const smaller = Math.min(features.size, prints.size);
    const containment = smaller ? shared / smaller : 0;
    const hit = overlap >= threshold || containment >= DEDUPE_CONTAINMENT || distance <= maxHamming;
    if (!hit) continue;
    if (!best || compare(overlap, distance, best.jaccard, best.hamming) < 0) {
      best = { entry: candidate, jaccard: overlap, hamming: distance };
    }
  }
  return best;
}

/** 回执里的一句话：让模型看得出「像在哪」。 */
export function describeDuplicate(match: DedupeMatch): string {
  const percent = Math.round(match.jaccard * 100);
  return `正文重合 ${percent}%，指纹距 ${match.hamming} 位`;
}

/** 越小越像：先看 Jaccard，再看汉明。 */
function compare(jaccardA: number, hammingA: number, jaccardB: number, hammingB: number): number {
  if (Math.abs(jaccardA - jaccardB) > 0.001) return jaccardB - jaccardA;
  return hammingA - hammingB;
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.99, Math.max(0.5, n));
}
