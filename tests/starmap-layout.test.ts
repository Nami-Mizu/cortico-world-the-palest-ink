import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHORS,
  findNode,
  hash32,
  layoutStarMap,
  nodeRadius,
  type StarPointInput,
} from '../src/webui/starmap-layout.ts';

function point(id: string, tags: string[], extra: Partial<StarPointInput> = {}): StarPointInput {
  return { id, tags, importance: 3, pinned: false, archived: false, expired: false, ...extra };
}

const TAGS = [
  { tag: '工作', count: 4 },
  { tag: '生活', count: 3 },
  { tag: '读书', count: 2 },
  { tag: '旅行', count: 1 },
];

describe('星图布局', () => {
  it('空数据也能画（只有画布尺寸）', () => {
    const layout = layoutStarMap([], [], 640, 400);
    expect(layout.width).toBe(640);
    expect(layout.height).toBe(400);
    expect(layout.anchors).toEqual([]);
    expect(layout.nodes).toEqual([]);
  });

  it('同一份数据每次布局一致（确定性）', () => {
    const points = Array.from({ length: 12 }, (_, index) => point(`mem_${index}`, [TAGS[index % 4]!.tag]));
    const left = layoutStarMap(points, TAGS, 720, 480);
    const right = layoutStarMap(points, TAGS, 720, 480);
    expect(right).toEqual(left);
  });

  it('标签圈按次数排序，最多八个，坐标落在画布内', () => {
    const many = [
      ...TAGS,
      ...Array.from({ length: 9 }, (_, index) => ({ tag: `extra${index}`, count: 1 })),
    ];
    const layout = layoutStarMap([point('a', ['工作'])], many, 700, 460);
    expect(layout.anchors.length).toBe(MAX_ANCHORS);
    expect(layout.anchors[0]?.tag).toBe('工作');
    for (const anchor of layout.anchors) {
      expect(anchor.x).toBeGreaterThanOrEqual(24);
      expect(anchor.x).toBeLessThanOrEqual(700 - 24);
      expect(anchor.y).toBeGreaterThanOrEqual(24);
      expect(anchor.y).toBeLessThanOrEqual(460 - 24);
      expect(anchor.radius).toBeGreaterThan(0);
    }
  });

  it('点都落在画布边距内，且没有 NaN', () => {
    const points = Array.from({ length: 40 }, (_, index) =>
      point(`m${index}`, index % 5 === 0 ? [] : [TAGS[index % 4]!.tag]),
    );
    const layout = layoutStarMap(points, TAGS, 640, 420);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(24);
      expect(node.x).toBeLessThanOrEqual(640 - 24);
      expect(node.y).toBeGreaterThanOrEqual(24);
      expect(node.y).toBeLessThanOrEqual(420 - 24);
    }
  });

  it('带标签的点更靠近自己标签的圈，而不是远处的圈', () => {
    const points = [point('work-1', ['工作']), point('work-2', ['工作']), point('life-1', ['生活'])];
    const layout = layoutStarMap(points, TAGS, 760, 520);
    const workAnchor = layout.anchors.find((anchor) => anchor.tag === '工作')!;
    const lifeAnchor = layout.anchors.find((anchor) => anchor.tag === '生活')!;
    const node = layout.nodes.find((item) => item.id === 'work-1')!;
    const distance = (x1: number, y1: number, x2: number, y2: number): number => Math.hypot(x1 - x2, y1 - y2);
    expect(distance(node.x, node.y, workAnchor.x, workAnchor.y)).toBeLessThan(
      distance(node.x, node.y, lifeAnchor.x, lifeAnchor.y),
    );
  });

  it('没有标签的点落得比标签圈更靠中心', () => {
    const layout = layoutStarMap([point('loose', [])], TAGS, 800, 520);
    const node = layout.nodes[0]!;
    const center = { x: 400, y: 260 };
    const ring = Math.min(800, 520) * 0.33;
    expect(Math.hypot(node.x - center.x, node.y - center.y)).toBeLessThan(ring);
  });

  it('同一标签下的点会被摊开，不会完全重叠', () => {
    const points = Array.from({ length: 10 }, (_, index) => point(`same-${index}`, ['工作']));
    const layout = layoutStarMap(points, TAGS, 700, 480);
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const left = layout.nodes[i]!;
        const right = layout.nodes[j]!;
        closest = Math.min(closest, Math.hypot(left.x - right.x, left.y - right.y));
      }
    }
    expect(closest).toBeGreaterThan(1);
  });

  it('findNode 只认圈内最近的点', () => {
    const nodes = [
      { id: 'a', x: 100, y: 100, radius: 6 },
      { id: 'b', x: 130, y: 100, radius: 6 },
    ];
    expect(findNode(nodes, 102, 101, 4)?.id).toBe('a');
    expect(findNode(nodes, 128, 100, 4)?.id).toBe('b');
    expect(findNode(nodes, 300, 300, 4)).toBeNull();
  });

  it('点的大小跟着重要度与置顶走', () => {
    expect(nodeRadius({ importance: 5, pinned: false })).toBeGreaterThan(nodeRadius({ importance: 1, pinned: false }));
    expect(nodeRadius({ importance: 3, pinned: true })).toBeGreaterThan(nodeRadius({ importance: 3, pinned: false }));
  });

  it('hash32 稳定且不随调用变化', () => {
    expect(hash32('mem_abc')).toBe(hash32('mem_abc'));
    expect(hash32('mem_abc')).not.toBe(hash32('mem_abd'));
  });
});
