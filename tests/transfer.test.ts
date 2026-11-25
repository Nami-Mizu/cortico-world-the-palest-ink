import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_ENTRIES,
  TRANSFER_SCHEMA,
  buildSnapshot,
  normalizeCandidate,
  parseSnapshot,
  planImport,
  type ImportPlan,
} from '../src/transfer.ts';

const entry = (id: string, text: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  text,
  kind: 'fact',
  tags: [],
  importance: 2,
  pinned: false,
  archived: false,
  createdAt: '2026-11-01T08:00:00.000+08:00',
  updatedAt: '2026-11-01T08:00:00.000+08:00',
  recallCount: 0,
  ...patch,
});

describe('导入导出：快照格式', () => {
  it('导出的快照能原样读回来', () => {
    const raw = buildSnapshot([entry('mem_a', '对方叫林照。')], '2026-11-26T00:00:00.000+08:00');
    const parsed = JSON.parse(raw) as { schema: number; app: string; entries: unknown[] };
    expect(parsed.schema).toBe(TRANSFER_SCHEMA);
    expect(parsed.app).toBe('thepalestink');
    expect(parsed.entries).toHaveLength(1);

    const snapshot = parseSnapshot(raw);
    expect(snapshot.exportedAt).toBe('2026-11-26T00:00:00.000+08:00');
    expect(snapshot.entries).toHaveLength(1);
  });

  it('裸数组也认（早期手写文件）', () => {
    const snapshot = parseSnapshot(JSON.stringify([entry('mem_a', '一条记忆。')]));
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.exportedAt).toBe('');
  });

  it('坏文件给中文原因，不抛 JSON 原始错误', () => {
    expect(() => parseSnapshot('')).toThrow('文件是空的');
    expect(() => parseSnapshot('{oops')).toThrow('不是合法的 JSON');
    expect(() => parseSnapshot('{"entries": 3}')).toThrow('没有 entries 数组');
  });

  it('一次导入上限拦住过大的文件', () => {
    const huge = JSON.stringify({ entries: Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, () => 1) });
    expect(() => parseSnapshot(huge)).toThrow('请拆开导入');
  });
});

describe('导入导出：预演计划', () => {
  it('合并模式：同 id 跳过、内容重复跳过、新的才写', () => {
    const local = [entry('mem_a', '对方叫林照，负责淡墨这个记忆库项目。')] as never;
    const plan: ImportPlan = planImport(local, [
      entry('mem_a', '对方叫林照，负责淡墨这个记忆库项目。'),
      entry('mem_b', '对方叫林照，负责淡墨这个记忆库项目，周四同步。'),
      entry('mem_c', '对方出生在杭州，现在住在上海。'),
    ], { mode: 'merge' });

    expect(plan.incoming).toBe(3);
    expect(plan.skipped).toBe(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.of).toBe('mem_a');
    expect(plan.added).toHaveLength(1);
    expect(plan.samples[0]?.id).toBe('mem_c');
  });

  it('合并模式不把归档条目当冲突（本地优先，只补缺）', () => {
    const local = [entry('mem_a', '对方喜欢喝黑咖啡。', { archived: true })] as never;
    const plan = planImport(local, [entry('mem_b', '对方喜欢喝黑咖啡。')], { mode: 'merge' });
    expect(plan.added).toHaveLength(1);
  });

  it('覆盖模式：本地被清空，同 id 也能进；文件内重复只留第一条', () => {
    const local = [entry('mem_a', '本地旧版本。'), entry('mem_x', '本地独有。')] as never;
    const plan = planImport(local, [
      entry('mem_a', '对方叫林照，负责淡墨这个记忆库项目。'),
      entry('mem_a', '对方叫林照，负责淡墨这个记忆库项目。'),
    ], { mode: 'replace' });

    expect(plan.mode).toBe('replace');
    expect(plan.added).toHaveLength(1);
    expect(plan.skipped).toBe(1);
  });

  it('缺 id 或正文的算非法，不中断整批', () => {
    const plan = planImport([], [{ id: 'mem_a' }, { text: '没有 id。' }, null, entry('mem_b', '正常的条目。')], { mode: 'merge' });
    expect(plan.invalid).toBe(3);
    expect(plan.added).toHaveLength(1);
  });

  it('kind 不认识的落成 note，正文去首尾空白', () => {
    const normalized = normalizeCandidate({ id: 'mem_a', text: '  空格不算正文。  ', kind: 'weird' });
    expect(normalized?.kind).toBe('note');
    expect(normalized?.text).toBe('空格不算正文。');
  });
});
