import { describe, expect, it } from 'vitest';
import { cosine, planQuery, searchEntries, tokenize } from '../src/search.ts';
import type { MemoryEntry } from '../src/types.ts';

const BASE: MemoryEntry = {
  id: 'mem_base',
  text: '',
  kind: 'note',
  tags: [],
  source: '',
  importance: 2,
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00',
  pinned: false,
  archived: false,
  recallCount: 0,
};

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { ...BASE, ...overrides };
}

const NOW = Date.parse('2026-01-02T00:00:00+08:00');

describe('tokenize / planQuery', () => {
  it('切词保留中文整段，丢掉单个拉丁字母', () => {
    expect(tokenize('A 旧 书店，Hello world!')).toEqual(['旧', '书店', 'hello', 'world']);
  });

  it('中文按 2-gram 展开，单字不切', () => {
    const plan = planQuery('旧书店');
    expect(plan.latin).toEqual([]);
    expect(plan.cjk).toEqual([{ phrase: '旧书店', grams: ['旧书', '书店'] }]);
    expect(planQuery('水').cjk).toEqual([{ phrase: '水', grams: [] }]);
  });

  it('中英混排分开处理', () => {
    const plan = planQuery('redis 缓存 过期');
    expect(plan.latin).toEqual(['redis']);
    expect(plan.cjk.map((unit) => unit.phrase)).toEqual(['缓存', '过期']);
  });
});

describe('searchEntries：字面', () => {
  it('中文长句拆成 2-gram 后能找到说法不同的条目', () => {
    const entries = [
      entry({ id: 'mem_book', text: '明天上午去城西的旧书店取订好的书' }),
      entry({ id: 'mem_other', text: '书店的书都很贵' }),
    ];
    const hits = searchEntries(entries, { query: '旧书店取书', now: NOW });
    expect(hits.map((hit) => hit.entry.id)).toEqual(['mem_book']);
  });

  it('拉丁词之间是 AND，不是 OR', () => {
    const entries = [
      entry({ id: 'mem_both', text: 'alpha beta gamma' }),
      entry({ id: 'mem_one', text: 'alpha only' }),
    ];
    const hits = searchEntries(entries, { query: 'alpha beta', now: NOW });
    expect(hits.map((hit) => hit.entry.id)).toEqual(['mem_both']);
  });

  it('标签与种类是过滤条件，标签大小写不敏感', () => {
    const entries = [
      entry({ id: 'mem_a', text: '部署脚本', kind: 'todo', tags: ['Work'] }),
      entry({ id: 'mem_b', text: '部署脚本', kind: 'note', tags: ['work'] }),
    ];
    expect(searchEntries(entries, { query: '部署', tags: ['WORK'], now: NOW }).map((hit) => hit.entry.id)).toEqual([
      'mem_a',
      'mem_b',
    ]);
    expect(searchEntries(entries, { query: '部署', kind: 'note', now: NOW }).map((hit) => hit.entry.id)).toEqual(['mem_b']);
  });

  it('归档条目默认不出现，除非明确要看', () => {
    const entries = [entry({ id: 'mem_live', text: '同一句' }), entry({ id: 'mem_dead', text: '同一句', archived: true })];
    expect(searchEntries(entries, { query: '同一句', now: NOW }).map((hit) => hit.entry.id)).toEqual(['mem_live']);
    expect(
      searchEntries(entries, { query: '同一句', includeArchived: true, now: NOW }).map((hit) => hit.entry.id).sort(),
    ).toEqual(['mem_dead', 'mem_live']);
  });

  it('没有检索词时按更新时间倒序，并守住上限', () => {
    const entries = [
      entry({ id: 'mem_old', text: '旧', updatedAt: '2025-12-01T00:00:00+08:00' }),
      entry({ id: 'mem_new', text: '新', updatedAt: '2026-01-01T00:00:00+08:00' }),
      entry({ id: 'mem_mid', text: '中', updatedAt: '2025-12-20T00:00:00+08:00' }),
    ];
    expect(searchEntries(entries, { query: '', limit: 2, now: NOW }).map((hit) => hit.entry.id)).toEqual(['mem_new', 'mem_mid']);
  });
});

describe('searchEntries：语义', () => {
  const hub = [1, 0, 0];
  const near = [0.95, 0.31, 0];
  const far = [0, 1, 0];

  it('字面完全没命中时，靠向量也能找回来', () => {
    const entries = [
      entry({ id: 'mem_sem', text: 'Zebra crossing etiquette' }),
      entry({ id: 'mem_off', text: 'Unrelated paragraph about taxes' }),
    ];
    const vectors: Record<string, number[]> = { mem_sem: near, mem_off: far };
    const hits = searchEntries(entries, {
      query: '斑马线怎么过',
      now: NOW,
      semantic: { queryVector: hub, weight: 0.5, vectorFor: (id) => vectors[id] ?? null },
    });
    expect(hits.map((hit) => hit.entry.id)).toEqual(['mem_sem']);
    expect(hits[0]?.semantic).toBeGreaterThan(0.9);
  });

  it('余弦低于门槛时不硬凑结果', () => {
    const entries = [entry({ id: 'mem_low', text: 'Zebra crossing' })];
    const hits = searchEntries(entries, {
      query: '斑马线',
      now: NOW,
      semantic: { queryVector: hub, weight: 0.5, minCosine: 0.9, vectorFor: () => [0.5, 0.86, 0] },
    });
    expect(hits).toEqual([]);
  });

  it('维度不一致的向量不参与语义打分', () => {
    const entries = [entry({ id: 'mem_dim', text: 'Zebra crossing' })];
    const hits = searchEntries(entries, {
      query: '斑马线',
      now: NOW,
      semantic: { queryVector: hub, weight: 0.5, vectorFor: () => [1, 0] },
    });
    expect(hits).toEqual([]);
  });

  it('字面命中与语义命中会叠加，语义高的排前面', () => {
    const entries = [
      entry({ id: 'mem_a', text: '斑马线 规则' }),
      entry({ id: 'mem_b', text: '斑马线 规则' }),
    ];
    const vectors: Record<string, number[]> = { mem_a: far, mem_b: near };
    const hits = searchEntries(entries, {
      query: '斑马线',
      now: NOW,
      semantic: { queryVector: hub, weight: 0.5, vectorFor: (id) => vectors[id] ?? null },
    });
    expect(hits.map((hit) => hit.entry.id)).toEqual(['mem_b', 'mem_a']);
  });
});

describe('cosine', () => {
  it('同向为 1、正交为 0、零向量为 0', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });
});
