import { describe, it, expect } from 'vitest';
import { fingerprint, jaccard, planMaintenance, type MaintenanceSettings } from '../src/maintenance.ts';
import type { MemoryEntry } from '../src/types.ts';

const NOW = new Date('2026-11-25T12:00:00+08:00');
const DAY = 86_400_000;

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? 'mem_top',
    text: '对方叫林照，负责淡墨这个记忆库项目。',
    kind: 'fact',
    tags: [],
    source: '',
    importance: 2,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
    pinned: false,
    archived: false,
    recallCount: 0,
    ...overrides,
  };
}

function settings(overrides: Partial<MaintenanceSettings> = {}): MaintenanceSettings {
  return { enabled: true, ageDays: 30, importance: 1, conflicts: true, similarity: 0.82, ...overrides };
}

describe('自动归档：过期条目', () => {
  it('久未取用且重要度不高于阈值的归档', () => {
    const old = entry({ id: 'mem_old', text: '上个月的临时安排。', importance: 1, updatedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() });
    const decisions = planMaintenance([old], settings(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.kind).toBe('stale');
    expect(decisions[0]!.reason).toContain('40 天');
  });

  it('最近取用过的从取用时间算，不再算过期', () => {
    const old = entry({
      id: 'mem_used',
      importance: 1,
      updatedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      lastRecalledAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      recallCount: 3,
    });
    expect(planMaintenance([old], settings(), NOW)).toEqual([]);
  });

  it('置顶与重要度 5 永不自动归档', () => {
    const stale = new Date(NOW.getTime() - 90 * DAY).toISOString();
    const pinned = entry({ id: 'mem_pin', importance: 1, pinned: true, updatedAt: stale });
    const sacred = entry({ id: 'mem_sacred', importance: 5, updatedAt: stale });
    expect(planMaintenance([pinned, sacred], settings({ importance: 4 }), NOW)).toEqual([]);
  });

  it('重要度高于阈值的留着', () => {
    const old = entry({ id: 'mem_big', importance: 3, updatedAt: new Date(NOW.getTime() - 90 * DAY).toISOString() });
    expect(planMaintenance([old], settings({ importance: 1 }), NOW)).toEqual([]);
  });

  it('总开关关掉就什么都不做', () => {
    const old = entry({ id: 'mem_off', importance: 0, updatedAt: new Date(NOW.getTime() - 365 * DAY).toISOString() });
    expect(planMaintenance([old], settings({ enabled: false }), NOW)).toEqual([]);
  });

  it('已归档的不再重复决定', () => {
    const archived = entry({
      id: 'mem_done',
      importance: 0,
      archived: true,
      archiveReason: '之前归档过',
      updatedAt: new Date(NOW.getTime() - 365 * DAY).toISOString(),
    });
    expect(planMaintenance([archived], settings(), NOW)).toEqual([]);
  });
});

describe('自动归档：事实冲突', () => {
  it('内容几乎重复时留重要的那条', () => {
    const winner = entry({ id: 'mem_new', importance: 3, updatedAt: NOW.toISOString() });
    const loser = entry({
      id: 'mem_dup',
      importance: 1,
      updatedAt: new Date(NOW.getTime() - 5 * DAY).toISOString(),
    });
    const decisions = planMaintenance([winner, loser], settings(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.id).toBe('mem_dup');
    expect(decisions[0]!.kind).toBe('conflict');
    expect(decisions[0]!.reason).toContain('内容重复');
  });

  it('同样重要时留较新的那条', () => {
    const newer = entry({ id: 'mem_b', updatedAt: NOW.toISOString() });
    const older = entry({ id: 'mem_a', updatedAt: new Date(NOW.getTime() - 5 * DAY).toISOString() });
    const decisions = planMaintenance([older, newer], settings(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.id).toBe('mem_a');
  });

  it('种类不同不算冲突', () => {
    const fact = entry({ id: 'mem_fact', kind: 'fact' });
    const note = entry({ id: 'mem_note', kind: 'note' });
    expect(planMaintenance([fact, note], settings(), NOW)).toEqual([]);
  });

  it('内容差得远就不动', () => {
    const left = entry({ id: 'mem_left', text: '对方叫林照，负责淡墨这个记忆库项目。' });
    const right = entry({ id: 'mem_right', text: '周五下午三点和设计对界面。' });
    expect(planMaintenance([left, right], settings(), NOW)).toEqual([]);
  });

  it('关掉查重开关就不查重复', () => {
    const left = entry({ id: 'mem_left', updatedAt: NOW.toISOString() });
    const right = entry({ id: 'mem_right', importance: 1, updatedAt: NOW.toISOString() });
    expect(planMaintenance([left, right], settings({ conflicts: false }), NOW)).toEqual([]);
  });
});

describe('文本指纹', () => {
  it('同样的正文相似度为 1', () => {
    expect(jaccard(fingerprint('降温了，记得带外套。'), fingerprint('降温了，记得带外套。'))).toBe(1);
  });

  it('完全不同的正文相似度为 0', () => {
    expect(jaccard(fingerprint('今天下雨。'), fingerprint('明天晴。'))).toBe(0);
  });

  it('空文本不参与比较', () => {
    expect(jaccard(fingerprint(''), fingerprint('有内容'))).toBe(0);
  });

  it('大小写不计，拉丁词按整词', () => {
    expect(jaccard(fingerprint('Release Notes'), fingerprint('release notes'))).toBe(1);
  });
});
