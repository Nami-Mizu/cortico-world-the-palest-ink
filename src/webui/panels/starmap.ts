/**
 * 「星图」页签：每条记忆一个点，标签是引力圈。
 *
 * 为什么只画点、不画线：
 * - 线只能表达「两两相关」，条数一多就变成一团毛；
 * - 「属于哪些标签」是稀疏的、可解释的，画成圈就够了。
 *
 * 点的语义：颜色 = 种类，大小 = 重要度，实心环 = 置顶，虚线圈 = 已过期，灰 = 归档。
 * 只读：点开只看详情，写入、改期、归档仍然走模型工具。
 */
import type { WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import type { EntryResponse, PanelResult, StarMapResponse, StarPoint } from '../panel-types.ts';
import { findNode, layoutStarMap, type StarLayout, type StarNode } from '../starmap-layout.ts';

const KIND_OPTIONS = [
  { value: '', label: '全部种类' },
  { value: 'fact', label: '事实' },
  { value: 'event', label: '事件' },
  { value: 'preference', label: '偏好' },
  { value: 'todo', label: '待办' },
  { value: 'note', label: '杂记' },
];

const KIND_COLORS: Record<string, string> = {
  fact: '#6fa8ff',
  event: '#ffb86b',
  preference: '#ff8fd0',
  todo: '#7fe0a0',
  note: '#b9a7ff',
};

const KIND_LABELS: Record<string, string> = {
  fact: '事实',
  event: '事件',
  preference: '偏好',
  todo: '待办',
  note: '杂记',
};

const MAP_HEIGHT = 520;

function when(iso: string): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const panel: WebUiPanel = {
  async mount(ctx) {
    const ui = ctx.ui;
    const sheet = ui.sheet({
      title: '星图',
      en: 'Star map',
      desc: '每条记忆一个点；圆圈是标签的引力范围。点的大小是重要度，实心眼是置顶，虚线圈是已过期。只读视图。',
    });
    ctx.root.append(sheet.el);

    const bar = ui.rowbar();
    const kind = ui.select({ options: KIND_OPTIONS });
    const tag = ui.input({ placeholder: '只看某个标签（可选）' });
    const archived = ui.checkbox('含归档');
    const reload = ui.button('刷新', { variant: 'primary', onClick: () => void load() });
    const resetView = ui.button('复位', { size: 'sm', onClick: () => reset() });
    const zoomIn = ui.button('＋', { size: 'sm', onClick: () => zoomAt(1.25) });
    const zoomOut = ui.button('－', { size: 'sm', onClick: () => zoomAt(0.8) });
    bar.append(kind, tag, archived.el, reload, resetView, zoomIn, zoomOut);
    sheet.body.append(bar);

    const msg = ui.msgline();
    sheet.body.append(msg);

    const wrap = ui.h('div');
    wrap.style.cssText = 'position:relative;margin:8px 0;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `display:block;width:100%;height:${MAP_HEIGHT}px;border-radius:10px;touch-action:none;cursor:grab;background:rgba(127,127,127,.06);`;
    const tip = ui.h('div');
    tip.style.cssText =
      'position:absolute;pointer-events:none;max-width:280px;padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.5;' +
      'background:rgba(20,20,24,.92);color:#eee;box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;z-index:2;white-space:pre-wrap;';
    wrap.append(canvas, tip);
    sheet.body.append(wrap);

    const legend = ui.h('div', 'muted');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;margin:4px 0 10px;';
    for (const [name, label] of Object.entries(KIND_LABELS)) {
      const item = ui.h('span');
      const dot = ui.h('span');
      dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:${KIND_COLORS[name] ?? '#888'};`;
      item.append(dot, document.createTextNode(label));
      legend.append(item);
    }
    const notes = ui.h('span', 'muted', '大小 = 重要度｜实心眼 = 置顶｜虚线圈 = 已过期｜灰 = 归档');
    legend.append(notes);
    sheet.body.append(legend);

    const detail = ui.h('div');
    sheet.body.append(detail);

    const state = {
      response: null as StarMapResponse | null,
      layout: null as StarLayout | null,
      byId: new Map<string, StarPoint>(),
      hover: null as StarNode | null,
      selected: null as string | null,
    };
    const view = { scale: 1, x: 0, y: 0 };

    const canvas2d = (): CanvasRenderingContext2D | null => canvas.getContext('2d');
    const cssWidth = (): number => Math.max(320, Math.round(canvas.clientWidth || wrap.clientWidth || 800));

    const reset = (): void => {
      view.scale = 1;
      view.x = 0;
      view.y = 0;
      draw();
    };

    /** 以画布中心为锚点缩放；滚轮则按光标位置缩放。 */
    const zoomAt = (factor: number): void => {
      const next = Math.min(3, Math.max(0.6, view.scale * factor));
      const ratio = next / view.scale;
      view.x *= ratio;
      view.y *= ratio;
      view.scale = next;
      draw();
    };

    const toWorld = (screenX: number, screenY: number): { x: number; y: number } => {
      const width = cssWidth();
      return {
        x: (screenX - width / 2 - view.x) / view.scale + width / 2,
        y: (screenY - MAP_HEIGHT / 2 - view.y) / view.scale + MAP_HEIGHT / 2,
      };
    };

    const draw = (): void => {
      const context = canvas2d();
      if (!context) return;
      const width = cssWidth();
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(MAP_HEIGHT * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(MAP_HEIGHT * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, MAP_HEIGHT);

      const layout = state.layout;
      if (!layout) return;

      const fg = getComputedStyle(canvas).color || '#ccc';
      context.save();
      context.translate(width / 2 + view.x, MAP_HEIGHT / 2 + view.y);
      context.scale(view.scale, view.scale);
      context.translate(-width / 2, -MAP_HEIGHT / 2);

      // 标签圈：只画轮廓和很淡的底，标签名放在圈心上方。
      context.lineWidth = 1;
      context.font = '11px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const anchor of layout.anchors) {
        context.globalAlpha = 0.5;
        context.strokeStyle = fg;
        context.beginPath();
        context.arc(anchor.x, anchor.y, anchor.radius, 0, Math.PI * 2);
        context.stroke();
        context.globalAlpha = 0.035;
        context.fillStyle = fg;
        context.fill();
        context.globalAlpha = 0.62;
        context.fillStyle = fg;
        context.fillText(`#${anchor.tag}`, anchor.x, anchor.y - anchor.radius - 9);
      }

      for (const node of layout.nodes) {
        const point = state.byId.get(node.id);
        if (!point) continue;
        const base = KIND_COLORS[point.kind] ?? '#9aa3b2';
        const selected = state.selected === point.id;
        const hovered = state.hover?.id === point.id;
        context.globalAlpha = point.archived ? 0.32 : hovered ? 1 : 0.88;
        context.fillStyle = base;
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();

        if (point.pinned) {
          context.globalAlpha = 0.85;
          context.strokeStyle = fg;
          context.lineWidth = 1.4;
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 2.4, 0, Math.PI * 2);
          context.stroke();
        }
        if (point.expired) {
          context.globalAlpha = 0.9;
          context.strokeStyle = '#ffb86b';
          context.lineWidth = 1.2;
          context.setLineDash([2.5, 2]);
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 4.2, 0, Math.PI * 2);
          context.stroke();
          context.setLineDash([]);
        }
        if (selected) {
          context.globalAlpha = 1;
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1.6;
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 6.5, 0, Math.PI * 2);
          context.stroke();
        }
        if (hovered) {
          context.globalAlpha = 0.55;
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1;
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
          context.stroke();
        }
      }

      context.restore();
      context.globalAlpha = 1;
      context.setLineDash([]);
    };

    const showTip = (node: StarNode, screenX: number, screenY: number): void => {
      const point = state.byId.get(node.id);
      if (!point) return;
      const flags = [point.pinned ? '置顶' : '', point.expired ? '已过期' : '', point.archived ? '已归档' : '']
        .filter(Boolean)
        .join(' · ');
      const tags = point.tags.length ? `#${point.tags.join(' #')}` : '（没有标签）';
      tip.textContent = `${point.text || '（只有标签）'}\n${point.kind ? KIND_LABELS[point.kind] ?? point.kind : ''}${flags ? ` · ${flags}` : ''}\n${tags}\n修订 ${when(point.updatedAt)} · 取用 ${point.recallCount} 次`;
      tip.style.display = 'block';
      const left = Math.min(screenX + 14, cssWidth() - 296);
      const top = Math.max(6, Math.min(screenY - 10, MAP_HEIGHT - 90));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const hideTip = (): void => {
      tip.style.display = 'none';
    };

    const showDetail = async (id: string): Promise<void> => {
      const busy = ui.busy('读取条目', id);
      try {
        const result = await ctx.invoke<PanelResult<EntryResponse>>('entry', [{ id }]);
        if (!result.ok || !result.data) {
          ui.toast(result.error ?? '读取失败', 'bad');
          return;
        }
        const data = result.data;
        const card = ui.h('div');
        card.style.cssText = 'margin-top:10px;padding:12px;border:1px solid rgba(128,128,128,.25);border-radius:10px;';
        const head = ui.h('div');
        head.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;';
        head.append(
          ui.pill(data.entry.kindLabel, 'off'),
          ui.pill(`重要度 ${data.entry.importance}`, 'off'),
          ...(data.entry.pinned ? [ui.pill('置顶', 'on')] : []),
          ...(data.entry.expired ? [ui.pill('已过期', 'plain')] : []),
          ...(data.entry.archived ? [ui.pill(`已归档：${data.archiveReason ?? '未写原因'}`, 'off')] : []),
        );
        const meta = ui.kv([
          { k: '编号', v: data.entry.id },
          { k: '标签', v: data.entry.tags.length ? `#${data.entry.tags.join(' #')}` : '（无）' },
          { k: '来源', v: data.source || '（未写）' },
          { k: '修订', v: when(data.entry.updatedAt) },
          { k: '取用', v: `${data.entry.recallCount} 次${data.lastRecalledAt ? `（最近 ${when(data.lastRecalledAt)}）` : ''}` },
          {
            k: '有效期',
            v: data.entry.expiresAt ? `${data.entry.ttlDays} 天，${when(data.entry.expiresAt)} 到期` : '永久',
          },
        ]);
        const text = ui.h('pre', 'mono', data.text);
        text.style.cssText = 'white-space:pre-wrap;margin:10px 0;max-height:240px;overflow:auto;';
        const actions = ui.actions();
        actions.append(
          ui.copyButton(data.text, { label: '复制正文' }),
          ui.button('关闭', { size: 'sm', onClick: () => card.remove() }),
        );
        card.append(head, meta, text, actions);
        detail.replaceChildren(card);
      } catch (error) {
        ui.toast(textOf(error), 'bad');
      } finally {
        busy.dispose();
      }
    };

    const load = async (): Promise<void> => {
      const busy = ui.busy('读取星图');
      msg.classList.remove('bad');
      msg.textContent = '读取中…';
      try {
        const result = await ctx.invoke<PanelResult<StarMapResponse>>('map', [
          {
            kind: kind.value,
            tag: tag.value.trim(),
            includeArchived: archived.checked,
          },
        ]);
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? '读取失败';
          msg.classList.add('bad');
          return;
        }
        state.response = result.data;
        state.byId = new Map(result.data.points.map((point) => [point.id, point]));
        state.hover = null;
        state.selected = null;
        hideTip();
        detail.replaceChildren();
        relayout();
        applyMessage();
        draw();
      } catch (error) {
        msg.textContent = textOf(error);
        msg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const applyMessage = (): void => {
      const response = state.response;
      if (!response) return;
      if (!response.points.length) {
        msg.textContent = '这里还没有点：让模型用 ink_remember 写第一条，或去掉筛选项。';
        return;
      }
      const parts = [`${response.counts.shown} 个点`];
      if (response.counts.archived) parts.push(`其中归档 ${response.counts.archived} 条`);
      if (response.truncated) parts.push(`另有 ${response.counts.matched - response.counts.shown} 条没画（点太多，缩小范围或提高容量）`);
      parts.push('拖拽平移，滚轮缩放，点圆点看详情');
      msg.textContent = parts.join('｜');
    };

    const relayout = (): void => {
      const response = state.response;
      if (!response) return;
      const layout = layoutStarMap(response.points, response.tags, cssWidth(), MAP_HEIGHT);
      state.layout = layout;
    };

    const onResize = (): void => {
      relayout();
      draw();
    };

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onResize());
    observer?.observe(wrap);
    ctx.signal.addEventListener('abort', () => observer?.disconnect(), { once: true });

    // ---- 指针：拖拽平移 / 滚轮缩放 / 悬停与点击 ----
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;
    let moved = 0;

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      moved = 0;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragOriginX = view.x;
      dragOriginY = view.y;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      if (dragging) {
        const dx = event.clientX - dragStartX;
        const dy = event.clientY - dragStartY;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        view.x = dragOriginX + dx;
        view.y = dragOriginY + dy;
        hideTip();
        draw();
        return;
      }
      const world = toWorld(event.clientX - rect.left, event.clientY - rect.top);
      const node = state.layout ? findNode(state.layout.nodes, world.x, world.y, 6) : null;
      state.hover = node;
      if (node) {
        canvas.style.cursor = 'pointer';
        showTip(node, event.clientX - rect.left, event.clientY - rect.top);
      } else {
        canvas.style.cursor = 'grab';
        hideTip();
      }
      draw();
    });

    canvas.addEventListener('pointerup', (event) => {
      dragging = false;
      canvas.style.cursor = 'grab';
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const world = toWorld(event.clientX - rect.left, event.clientY - rect.top);
      const node = state.layout ? findNode(state.layout.nodes, world.x, world.y, 6) : null;
      if (!node) {
        state.selected = null;
        detail.replaceChildren();
        draw();
        return;
      }
      state.selected = node.id;
      draw();
      void showDetail(node.id);
    });

    canvas.addEventListener('pointerleave', () => {
      state.hover = null;
      hideTip();
      draw();
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;
        const width = cssWidth();
        const next = Math.min(3, Math.max(0.6, view.scale * (event.deltaY < 0 ? 1.12 : 0.89)));
        const worldX = (screenX - width / 2 - view.x) / view.scale + width / 2;
        const worldY = (screenY - MAP_HEIGHT / 2 - view.y) / view.scale + MAP_HEIGHT / 2;
        view.x = screenX - width / 2 - (worldX - width / 2) * next;
        view.y = screenY - MAP_HEIGHT / 2 - (worldY - MAP_HEIGHT / 2) * next;
        view.scale = next;
        draw();
      },
      { passive: false },
    );

    await load();
  },
};

export default panel;
