import { describe, expect, it } from 'vitest';
import {
  DEDUPE_HAMMING,
  MIN_FEATURES,
  describeDuplicate,
  findDuplicate,
  hamming64,
  hash32,
  simhash64,
  type DedupeCandidate,
} from '../src/dedupe.ts';

const candidate = (id: string, text: string, patch: Partial<DedupeCandidate> = {}): DedupeCandidate => ({
  id,
  text,
  kind: 'fact',
  ...patch,
});

describe('查重：指纹与判定', () => {
  it('hash32 稳定，换个字就变', () => {
    expect(hash32('林照')).toBe(hash32('林照'));
    expect(hash32('林照')).not.toBe(hash32('林昭'));
  });

  it('同一段文本的 simhash 汉明距离为 0，差一段就大于 0', () => {
    const left = simhash64('对方叫林照，负责淡墨这个记忆库项目。');
    const right = simhash64('对方叫林照，负责淡墨这个记忆库项目。');
    expect(hamming64(left, right)).toBe(0);
    expect(hamming64(left, simhash64('今天天气不错，适合去公园散步。'))).toBeGreaterThan(DEDUPE_HAMMING);
  });

  it('同一件事补了后半句能判成同一条（包含度兜住 Jaccard 的下滑）', () => {
    const pool = [candidate('mem_a', '周三下午三点和对方过一遍记忆库的导出。')];
    const match = findDuplicate(pool, '周三下午三点和对方过一遍记忆库的导出，顺带看面板。');
    expect(match?.entry.id).toBe('mem_a');
  });

  it('换了关键信息（周三→周五）就不算重复：那是另一条事实，不该被拦', () => {
    const pool = [candidate('mem_a', '对方叫林照，负责淡墨这个记忆库项目，周三同步进度。')];
    expect(findDuplicate(pool, '对方叫林照，负责淡墨这个记忆库项目，周五同步进度。')).toBeNull();
  });

  it('归档的、置顶的都不参与查重', () => {
    const pool = [
      candidate('mem_archived', '对方喜欢在早上七点半喝一杯黑咖啡。', { archived: true }),
      candidate('mem_pinned', '对方喜欢在早上七点半喝一杯黑咖啡。', { pinned: true }),
    ];
    expect(findDuplicate(pool, '对方喜欢在早上七点半喝一杯黑咖啡。')).toBeNull();
  });

  it('只和同 kind 的条目比', () => {
    const pool = [candidate('mem_note', '这条是待办：整理记忆库的标签。', { kind: 'todo' })];
    expect(findDuplicate(pool, '这条是待办：整理记忆库的标签。', { kind: 'fact' })).toBeNull();
    expect(findDuplicate(pool, '这条是待办：整理记忆库的标签。', { kind: 'todo' })?.entry.id).toBe('mem_note');
  });

  it('特征太少（短句）时不判重，宁可漏判', () => {
    expect(MIN_FEATURES).toBe(3);
    const pool = [candidate('mem_a', '好的')];
    expect(findDuplicate(pool, '好的')).toBeNull();
  });

  it('excludeId 能跳过自己（改正文时用）', () => {
    const pool = [candidate('mem_a', '对方叫林照，负责淡墨这个记忆库项目。')];
    expect(findDuplicate(pool, '对方叫林照，负责淡墨这个记忆库项目。')?.entry.id).toBe('mem_a');
    expect(findDuplicate(pool, '对方叫林照，负责淡墨这个记忆库项目。', { excludeId: 'mem_a' })).toBeNull();
  });

  it('回执文案给出重合度与指纹距离', () => {
    const match = findDuplicate([candidate('mem_a', '对方叫林照，负责淡墨这个记忆库项目。')], '对方叫林照，负责淡墨这个记忆库项目。');
    expect(match).not.toBeNull();
    expect(describeDuplicate(match!)).toMatch(/正文重合 \d+%，指纹距 \d+ 位/);
  });
});
