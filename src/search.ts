/**
 * 检索：字面命中 + 可选的语义（向量）命中。
 *
 * 字面部分不引分词器：按空白与标点切词，中文再按 2-gram 放宽——
 * 长句提问时，原句整体当子串命中的机会很小，拆成相邻两字就能找到「意思没变、说法不同」的条目。
 * 多个拉丁词之间仍是「都要命中」（AND）；中文单元要求至少一半的 2-gram 命中。
 *
 * 语义部分只在这里做「余弦 + 加权」，不含任何网络调用：向量由调用方算好传进来，
 * 于是 `_dev/verify.mjs`、测试与面板都能复用同一套排序。
 */

import { isExpired, type MemoryEntry, type MemoryKind, type MemoryMood } from './types.ts';

/** 一次检索最多认几个词（再多就当用户粘了一整段）。 */
export const MAX_TERMS = 8;
/** 一次最多返回多少条。 */
export const MAX_RESULTS = 50;
/** 语义命中单独入选的最低余弦。低于它、又没有字面命中，就不算「找到」。 */
export const DEFAULT_MIN_COSINE = 0.35;
/** 已过期条目的排序降权：仍然能找到，但排在新鲜的同分条目之后。 */
export const EXPIRED_PENALTY = 0.8;

export interface SearchOptions {
  /** 检索词；空串返回空结果（除非只给了 tags/kind）。 */
  query: string;
  /** 这些标签都要有（大小写不敏感）。 */
  tags?: readonly string[];
  /** 只看某个种类。 */
  kind?: MemoryKind;
  /** 只看某一种情绪。 */
  mood?: MemoryMood;
  /** 返回上限，默认 8。 */
  limit?: number;
  /** 是否连归档一起找，默认 false。 */
  includeArchived?: boolean;
  /** 排序用的「现在」，测试里可固定。 */
  now?: number;
  /** 语义通道；不给就只做字面检索。 */
  semantic?: SemanticOptions;
}

export interface SemanticOptions {
  /** 查询向量；维度与条目向量不一致时该条目不参与语义打分。 */
  queryVector: readonly number[];
  /** 语义分权重 0–1。 */
  weight: number;
  /** 低于这个余弦不算语义命中，缺省 0.35。 */
  minCosine?: number;
  /** 取某条目的向量；没有就返回 null。 */
  vectorFor(entryId: string): readonly number[] | null;
}

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  /** 命中的词/2-gram，按用户输入顺序。 */
  matched: string[];
  /** 语义余弦；没走语义或维度不符时是 undefined。 */
  semantic?: number;
  /** 这条已经过期（命中照给，排序降权，回执要标出来）。 */
  expired?: boolean;
}

export interface CjkUnit {
  /** 原词（整句当子串用）。 */
  phrase: string;
  /** 相邻两字的切片；单字词为空数组。 */
  grams: string[];
}

export interface QueryPlan {
  /** 原查询。 */
  raw: string;
  /** 拉丁/数字词，必须全部命中。 */
  latin: string[];
  /** 中文单元，各自要求一定覆盖。 */
  cjk: CjkUnit[];
  /** 展示用的词表。 */
  terms: string[];
}

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 切词：按非字母数字切，去掉过短的拉丁词，去重并保序。 */
export function tokenize(query: string): string[] {
  const out: string[] = [];
  for (const piece of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const term = piece.trim();
    if (!term) continue;
    // 单个拉丁字母几乎不筛东西，中文单字则常常有意义（如「水」）。
    if (term.length === 1 && /[a-z0-9]/.test(term)) continue;
    if (!out.includes(term)) out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** 把查询拆成「必须全中的拉丁词」与「按覆盖算的中文单元」。 */
export function planQuery(query: string): QueryPlan {
  const terms = tokenize(query);
  const latin: string[] = [];
  const cjk: CjkUnit[] = [];
  for (const term of terms) {
    if (!CJK_RE.test(term)) {
      latin.push(term);
      continue;
    }
    const grams: string[] = [];
    // 只按字符切 2-gram；单字词不切，靠整字命中。
    const chars = Array.from(term);
    if (chars.length >= 2) {
      for (let index = 0; index + 1 < chars.length; index += 1) {
        const gram = `${chars[index]}${chars[index + 1]}`;
        if (!grams.includes(gram)) grams.push(gram);
      }
    }
    cjk.push({ phrase: term, grams: grams.slice(0, 12) });
  }
  return { raw: query, latin, cjk, terms };
}

/** 子串出现次数，大小写不敏感（两边都先小写）。 */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  let count = 0;
  let index = hay.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = hay.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 一条记忆对某个拉丁词的得分；0 表示没命中。 */
function scoreLatinTerm(entry: MemoryEntry, term: string): number {
  let score = Math.min(occurrences(entry.text, term), 3) * 3;
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  if (tags.includes(term)) score += 5;
  else if (tags.some((tag) => tag.includes(term))) score += 2;
  if (entry.source && entry.source.toLowerCase().includes(term)) score += 1;
  return score;
}

/** 中文单元：整句命中给满，否则按 2-gram 覆盖算；覆盖不足一半算没命中。 */
function scoreCjkUnit(entry: MemoryEntry, unit: CjkUnit): number {
  const whole = occurrences(entry.text, unit.phrase);
  if (whole > 0) return 3 + Math.min(whole, 3);
  if (!unit.grams.length) return 0;
  const hits = unit.grams.filter((gram) => occurrences(entry.text, gram) > 0).length;
  const coverage = hits / unit.grams.length;
  if (coverage < 0.5) return 0;
  return 3 * coverage;
}

function recencyBonus(entry: MemoryEntry, now: number): number {
  const stamp = Date.parse(entry.updatedAt);
  if (!Number.isFinite(stamp)) return 0;
  const ageDays = Math.max(0, (now - stamp) / 86_400_000);
  return Math.max(0, 1 - ageDays / 90) * 1.5;
}

/** 余弦相似度；维度不一致或零向量返回 0。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** 检索计划的摘要，给回执/面板解释「为什么算命中」。 */
export function describePlan(plan: QueryPlan): string {
  const parts: string[] = [];
  if (plan.latin.length) parts.push(`词：${plan.latin.join('、')}`);
  if (plan.cjk.length) parts.push(`中文单元：${plan.cjk.map((unit) => unit.phrase).join('、')}`);
  return parts.join('；') || '（没有检索词）';
}

/**
 * 在给定条目里检索。`entries` 原样不动；返回的是排序后的引用。
 * 没给词时按「最近更新」返回（供 tags/kind 过滤后的浏览）。
 */
export function searchEntries(entries: readonly MemoryEntry[], opts: SearchOptions): SearchHit[] {
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.round(opts.limit ?? 8)));
  const now = opts.now ?? Date.now();
  const plan = planQuery(opts.query);
  const wantedTags = (opts.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);

  const pool = entries.filter((entry) => {
    if (!opts.includeArchived && entry.archived) return false;
    if (opts.kind && entry.kind !== opts.kind) return false;
    if (opts.mood && entry.mood !== opts.mood) return false;
    if (wantedTags.length) {
      const tags = entry.tags.map((tag) => tag.toLowerCase());
      if (!wantedTags.every((tag) => tags.includes(tag))) return false;
    }
    return true;
  });

  const hasQuery = plan.latin.length > 0 || plan.cjk.length > 0;
  if (!hasQuery) {
    return pool
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.importance - a.importance || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0, matched: [], ...(isExpired(entry, now) ? { expired: true } : {}) }));
  }

  const semantic = opts.semantic;
  const minCosine = semantic?.minCosine ?? DEFAULT_MIN_COSINE;
  const hits: SearchHit[] = [];

  for (const entry of pool) {
    let lexical = 0;
    const matched: string[] = [];
    let literal = true;

    for (const term of plan.latin) {
      const score = scoreLatinTerm(entry, term);
      if (score <= 0) {
        literal = false;
        break;
      }
      lexical += score;
      matched.push(term);
    }

    if (literal) {
      for (const unit of plan.cjk) {
        const score = scoreCjkUnit(entry, unit);
        if (score <= 0) {
          literal = false;
          break;
        }
        lexical += score;
        matched.push(unit.phrase);
      }
    }

    let similarity: number | undefined;
    let semanticScore = 0;
    if (semantic && semantic.queryVector.length) {
      const vector = semantic.vectorFor(entry.id);
      if (vector && vector.length === semantic.queryVector.length) {
        const value = cosine(semantic.queryVector, vector);
        similarity = value;
        if (value >= minCosine) semanticScore = Math.max(0, semantic.weight) * 10 * value;
      }
    }

    if (!literal && semanticScore <= 0) continue;

    const expired = isExpired(entry, now);
    const bonus = entry.importance * 0.5 + (entry.pinned ? 1 : 0) + recencyBonus(entry, now);
    const score = (literal ? lexical : 0) + semanticScore + bonus - (expired ? EXPIRED_PENALTY : 0);
    hits.push({
      entry,
      score,
      matched,
      ...(similarity !== undefined ? { semantic: similarity } : {}),
      ...(expired ? { expired: true } : {}),
    });
  }

  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, limit);
}

/** 按情绪取几条：重要度高的在前，其次是被取用多的、最近更新的。只取未归档。 */
export function pickByMood(entries: readonly MemoryEntry[], mood: MemoryMood, limit = 5): MemoryEntry[] {
  const cap = Math.min(MAX_RESULTS, Math.max(1, Math.round(limit)));
  return entries
    .filter((entry) => !entry.archived && entry.mood === mood)
    .slice()
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        b.recallCount - a.recallCount ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, cap);
}
