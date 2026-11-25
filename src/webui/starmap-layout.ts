/**
 * 记忆星图的布局：纯函数、确定性、不碰 DOM（测试与面板共用）。
 *
 * 规则：
 * - 每个标签是一个「引力圈」，圈心按标签出现次数从多到少排在外圈；
 * - 每条记忆落在它所属标签圈心的加权中点附近，没有标签的落在内圈；
 * - 位置由 id 的哈希决定抖动，同一份数据每次画出来都一样；
 * - 最后一轮简单排斥，避免点叠在一起。
 *
 * 点之间不连线：线的数量是 O(n²) 的噪声，而「属于哪个圈」已经表达了关系。
 */
import type { TagCount } from './panel-types.ts';

export interface StarPointInput {
  id: string;
  tags: readonly string[];
  importance: number;
  pinned: boolean;
  archived: boolean;
  expired: boolean;
}

export interface StarAnchor {
  tag: string;
  count: number;
  x: number;
  y: number;
  radius: number;
}

export interface StarNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface StarLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  anchors: StarAnchor[];
  nodes: StarNode[];
}

/** 最多画几个标签圈——再多就分不清了。 */
export const MAX_ANCHORS = 8;
/** 单次布局最多放多少个点（超过的条目只在列表里看）。 */
export const MAX_LAYOUT_POINTS = 800;

const MARGIN = 24;
const RELAX_ITERATIONS = 48;
const GOLDEN = 0x9e3779b9;

/** FNV-1a：稳定、跨平台一致，用来把 id 变成抖动种子。 */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function noise(seed: number, salt: number): number {
  const mixed = (seed ^ Math.imul(salt + GOLDEN, 0x85ebca6b)) >>> 0;
  return ((mixed ^ (mixed >>> 15)) >>> 0) / 0xffffffff;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 点的大小跟着重要度；置顶再加一点。 */
export function nodeRadius(point: Pick<StarPointInput, 'importance' | 'pinned'>): number {
  const importance = Number.isFinite(point.importance) ? clamp(point.importance, 0, 5) : 0;
  return 3.6 + importance * 1.25 + (point.pinned ? 1.1 : 0);
}

/** 找出离 (x, y) 最近、且在点半径内的节点。 */
export function findNode(nodes: readonly StarNode[], x: number, y: number, slack = 8): StarNode | null {
  let best: StarNode | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= node.radius + slack && distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

export function layoutStarMap(
  points: readonly StarPointInput[],
  tagCounts: readonly TagCount[],
  width: number,
  height: number,
): StarLayout {
  const w = Math.max(320, Math.round(width));
  const h = Math.max(240, Math.round(height));
  const centerX = w / 2;
  const centerY = h / 2;
  const ring = Math.min(w, h) * 0.33;
  const maxRadius = Math.min(w, h) / 2 - MARGIN;

  const ranked = tagCounts
    .filter((item) => item.count > 0 && item.tag)
    .slice()
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    .slice(0, MAX_ANCHORS);

  const anchors: StarAnchor[] = ranked.map((item, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, ranked.length);
    return {
      tag: item.tag,
      count: item.count,
      x: centerX + Math.cos(angle) * ring,
      y: centerY + Math.sin(angle) * ring,
      radius: Math.min(maxRadius, 26 + 5 * Math.sqrt(item.count)),
    };
  });

  const anchorByTag = new Map<string, StarAnchor>();
  for (const anchor of anchors) anchorByTag.set(anchor.tag, anchor);

  const membersOf = (point: StarPointInput): StarAnchor[] => {
    const found: StarAnchor[] = [];
    for (const tag of point.tags) {
      const anchor = anchorByTag.get(tag);
      if (anchor) found.push(anchor);
    }
    return found;
  };

  const kept = points.slice(0, MAX_LAYOUT_POINTS);
  const clusterSize = new Map<string, number>();
  for (const point of kept) {
    const members = membersOf(point);
    if (!members.length) continue;
    const tag = members[0]?.tag;
    if (tag) clusterSize.set(tag, (clusterSize.get(tag) ?? 0) + 1);
  }

  interface Working {
    id: string;
    x: number;
    y: number;
    targetX: number;
    targetY: number;
    radius: number;
  }

  const working: Working[] = kept.map((point) => {
    const seed = hash32(point.id);
    const members = membersOf(point);
    let targetX = centerX;
    let targetY = centerY;
    let spread = 5;

    if (members.length) {
      let sumX = 0;
      let sumY = 0;
      for (const anchor of members) {
        sumX += anchor.x;
        sumY += anchor.y;
      }
      targetX = sumX / members.length;
      targetY = sumY / members.length;
      const firstTag = members[0]?.tag ?? '';
      spread = 8 + 6 * Math.sqrt(clusterSize.get(firstTag) ?? 1);
    } else {
      // 没有标签的点落在内圈：不和任何圈绑定，但仍然看得出来是「散的」。
      const angle = noise(seed, 1) * Math.PI * 2;
      const radius = 34 + noise(seed, 2) * ring * 0.52;
      targetX = centerX + Math.cos(angle) * radius;
      targetY = centerY + Math.sin(angle) * radius;
      spread = 4;
    }

    const angle = noise(seed, 3) * Math.PI * 2;
    const radial = spread * (0.35 + noise(seed, 4) * 0.65);
    return {
      id: point.id,
      x: targetX + Math.cos(angle) * radial,
      y: targetY + Math.sin(angle) * radial,
      targetX,
      targetY,
      radius: nodeRadius(point),
    };
  });

  // 简单的两两排斥 + 轻微回拉，够把重叠的点摊开；n 最多 800，n² 一次可以接受。
  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
    for (let i = 0; i < working.length; i += 1) {
      const left = working[i];
      if (!left) continue;
      for (let j = i + 1; j < working.length; j += 1) {
        const right = working[j];
        if (!right) continue;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy);
        const minimum = left.radius + right.radius + 3.2;
        if (distance >= minimum) continue;
        const direction = distance < 0.05 ? noise(hash32(left.id + right.id), iteration) * Math.PI * 2 : Math.atan2(dy, dx);
        const push = (minimum - distance) / 2;
        const cos = Math.cos(direction) * push;
        const sin = Math.sin(direction) * push;
        left.x -= cos;
        left.y -= sin;
        right.x += cos;
        right.y += sin;
      }
    }
    for (const item of working) {
      item.x += (item.targetX - item.x) * 0.035;
      item.y += (item.targetY - item.y) * 0.035;
      item.x = clamp(item.x, MARGIN, w - MARGIN);
      item.y = clamp(item.y, MARGIN, h - MARGIN);
    }
  }

  return {
    width: w,
    height: h,
    centerX,
    centerY,
    anchors: anchors.map((anchor) => ({
      ...anchor,
      x: clamp(anchor.x, MARGIN, w - MARGIN),
      y: clamp(anchor.y, MARGIN, h - MARGIN),
    })),
    nodes: working.map((item) => ({ id: item.id, x: item.x, y: item.y, radius: item.radius })),
  };
}
