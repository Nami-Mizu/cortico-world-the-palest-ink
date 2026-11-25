import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VectorStore } from '../src/vector.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ink-vector-'));
}

function open(dataDir: string): VectorStore {
  return new VectorStore({ dataDir, timezone: 'Asia/Shanghai' });
}

describe('VectorStore', () => {
  it('写入、读取、按 id 删除，并落盘给下一次启动', () => {
    const dataDir = scratch();
    const store = open(dataDir);
    store.put('mem_a', [0.1, 0.2, 0.3], '2026-01-01T00:00:00+08:00');
    store.put('mem_b', [1, 0, 0], '2026-01-01T00:00:01+08:00');
    expect(store.count()).toBe(2);
    expect(store.dims()).toBe(3);
    expect(store.get('mem_a')).toEqual([0.1, 0.2, 0.3]);

    const again = open(dataDir);
    expect(again.count()).toBe(2);
    expect(again.get('mem_b')).toEqual([1, 0, 0]);

    store.remove('mem_a');
    expect(open(dataDir).get('mem_a')).toBeNull();
    expect(open(dataDir).count()).toBe(1);
  });

  it('分量保留 5 位小数，避免文件虚胖', () => {
    const store = open(scratch());
    store.put('mem_pi', [Math.PI, 1 / 3], '2026-01-01T00:00:00+08:00');
    expect(store.get('mem_pi')).toEqual([3.14159, 0.33333]);
  });

  it('prune 清掉不在记忆库里的向量，missing 列出还没算的', () => {
    const store = open(scratch());
    store.put('mem_a', [1, 0], '2026-01-01T00:00:00+08:00');
    store.put('mem_b', [0, 1], '2026-01-01T00:00:00+08:00');
    expect(store.missing(['mem_a', 'mem_b', 'mem_c'])).toEqual(['mem_c']);
    expect(store.prune(new Set(['mem_b']))).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.get('mem_a')).toBeNull();
  });

  it('换模型时整仓作废，只留新模型名与维度', () => {
    const store = open(scratch());
    store.put('mem_a', [1, 0, 0], '2026-01-01T00:00:00+08:00');
    store.reset('text-embedding-3-large', 3072);
    expect(store.count()).toBe(0);
    expect(store.model()).toBe('text-embedding-3-large');
    expect(store.dims()).toBe(3072);
  });

  it('记账：成功与失败分别计数，预算按当天算', () => {
    const store = open(scratch());
    expect(store.remainingBudget(2)).toBe(2);
    store.bumpUsage(true);
    store.bumpUsage(false, '429');
    const usage = store.usage();
    expect(usage.calls).toBe(2);
    expect(usage.failures).toBe(1);
    expect(usage.totalCalls).toBe(2);
    expect(usage.lastError).toBe('429');
    expect(store.remainingBudget(2)).toBe(0);
  });

  it('坏档改名备份后空仓继续，不静默丢数据', () => {
    const dataDir = scratch();
    const store = open(dataDir);
    store.put('mem_a', [1, 0], '2026-01-01T00:00:00+08:00');
    const file = store.file;
    writeFileSync(file, '{ 这不是 JSON', 'utf8');

    const broken = open(dataDir);
    expect(broken.count()).toBe(0);
    const backup = broken.recovery();
    expect(backup).toBeTruthy();
    expect(readFileSync(backup as string, 'utf8')).toContain('这不是 JSON');
  });
});
