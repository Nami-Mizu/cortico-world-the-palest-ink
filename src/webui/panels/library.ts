/**
 * 「记忆库」页签：列表 + 检索 + 条目全文。
 *
 * 只读：写入、修订、归档都走模型工具，面板不提供第二套入口，
 * 免得人类和模型对同一条记忆给出两种说法。
 */
import type { WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import type { EntryResponse, LibrarySnapshot, PanelEntry, PanelResult, SearchResponse } from '../panel-types.ts';

const KIND_OPTIONS = [
  { value: '', label: '全部种类' },
  { value: 'fact', label: '事实' },
  { value: 'event', label: '事件' },
  { value: 'preference', label: '偏好' },
  { value: 'todo', label: '待办' },
  { value: 'note', label: '杂记' },
];

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
      title: '记忆库',
      en: 'The Palest Ink',
      desc: '只读视图：写入与修订由模型通过工具完成。这里能看清单、按关键词检索、读全文。',
    });
    ctx.root.append(sheet.el);

    const stats = ui.statgrid();
    const embedLine = ui.h('div', 'msgline');
    sheet.body.append(stats, embedLine);

    // 写记忆的节奏：只读展示；改在 World 配置页（两组配置：记忆库 / 写记忆的节奏）。
    const rhythmBox = ui.h('div');
    rhythmBox.style.cssText = 'margin:10px 0;padding:10px 12px;border:1px solid rgba(128,128,128,.25);border-radius:8px;';
    const rhythmTitle = ui.h('div', 'muted', '写记忆的节奏（只读；在 World 配置里改）');
    rhythmTitle.style.fontSize = '12px';
    const rhythmBody = ui.h('div');
    rhythmBox.append(rhythmTitle, rhythmBody);
    sheet.body.append(rhythmBox);

    const bar = ui.rowbar();
    const query = ui.input({ type: 'search', placeholder: '关键词，空格分隔；中文按相邻两字匹配' });
    const tag = ui.input({ placeholder: '标签（可选）' });
    const kind = ui.select({ options: KIND_OPTIONS });
    const archived = ui.checkbox('含归档');
    const submit = ui.button('检索', { variant: 'primary', onClick: () => void run() });
    bar.append(query, tag, kind, archived.el, submit);
    const recentBtn = ui.button('看最近', { size: 'sm', onClick: () => void load(true) });
    bar.append(recentBtn);
    sheet.body.append(bar);

    const msg = ui.msgline();
    sheet.body.append(msg);

    const table = ui.table({
      head: ['编号', '摘要', '种类', '重要度', '最近修订', ''],
      maxHeight: 'calc(100vh - 360px)',
    });
    sheet.body.append(table.el);

    const note = ui.h('div', 'muted');
    note.style.marginTop = '10px';
    note.style.fontSize = '12px';
    sheet.body.append(note);

    const openEntry = async (id: string): Promise<void> => {
      const busy = ui.busy('读取条目', id);
      try {
        const result = await ctx.invoke<PanelResult<EntryResponse>>('entry', [{ id }]);
        if (!result.ok || !result.data) {
          ui.toast(result.error ?? '读取失败', 'bad');
          return;
        }
        const entry = result.data;
        const body = ui.h('div');
        const meta = ui.kv([
          { k: '编号', v: entry.entry.id },
          { k: '种类', v: entry.entry.kindLabel },
          { k: '重要度', v: entry.entry.importance },
          { k: '标签', v: entry.entry.tags.length ? `#${entry.entry.tags.join(' #')}` : '（无）' },
          { k: '来源', v: entry.source || '（未写）' },
          { k: '写入', v: when(entry.entry.createdAt) },
          { k: '修订', v: when(entry.entry.updatedAt) },
          { k: '取用', v: `${entry.entry.recallCount} 次${entry.lastRecalledAt ? `（最近 ${when(entry.lastRecalledAt)}）` : ''}` },
          {
            k: '有效期',
            v: entry.entry.expiresAt
              ? `${entry.entry.ttlDays} 天，${when(entry.entry.expiresAt)} 到期${entry.entry.expired ? '（已过期，待整理）' : ''}`
              : '永久',
          },
          { k: '已向量化', v: entry.vectorized ? '是' : '否（语义检索找不到它）' },
        ]);
        const text = ui.h('pre', 'mono', entry.text);
        text.style.whiteSpace = 'pre-wrap';
        text.style.margin = '12px 0';
        const actions = ui.actions();
        actions.append(ui.copyButton(entry.text, { label: '复制正文' }));
        if (entry.entry.archived) {
          actions.append(ui.pill(`已归档：${entry.archiveReason ?? '未写原因'}`, 'off'));
        }
        body.append(meta, text, actions);
        ui.drawer(`记忆 ${entry.entry.id}`, body);
      } catch (error) {
        ui.toast(textOf(error), 'bad');
      } finally {
        busy.dispose();
      }
    };

    const renderRows = (hits: Array<PanelEntry & { semantic?: boolean }>): void => {
      table.clear('没有匹配的记忆。换个词、去掉标签，或点「看最近」。');
      for (const hit of hits) {
        const flags = [hit.pinned ? '置顶' : '', hit.archived ? '归档' : '', hit.expired ? '已过期' : '', hit.semantic ? '≈' : ''].filter(Boolean).join(' ');
        const row = table.addRow([
          hit.id.slice(0, 14),
          hit.text || hit.tags.map((item) => `#${item}`).join(' '),
          hit.kindLabel,
          String(hit.importance),
          when(hit.updatedAt),
          ui.button('查看', { size: 'sm', onClick: () => void openEntry(hit.id) }),
        ]);
        row.addEventListener('dblclick', () => void openEntry(hit.id));
        if (flags) {
          row.title = flags;
        }
      }
    };

    const renderRhythm = (rhythm: LibrarySnapshot['rhythm']): void => {
      const lines: string[] = [];
      if (!rhythm.cron) lines.push('定时提醒：关（在配置里填 cron，例如 30 7 * * *）');
      else if (!rhythm.cronValid) lines.push(`定时提醒：cron 写错了 —— ${rhythm.cronError ?? '无法解析'}`);
      else lines.push(`定时提醒：${rhythm.cronText ?? rhythm.cron}（cron「${rhythm.cron}」）${rhythm.cronNextAt ? `，下次 ${when(rhythm.cronNextAt)}` : ''}`);
      lines.push(
        rhythm.contextPercentLimit
          ? `上下文提醒：估到 ${rhythm.contextPercentLimit}% 时提醒（现在约 ${rhythm.estimatedPercent ?? '—'}%，${rhythm.estimatedTokens} / ${rhythm.contextWindow ?? '未知'} token，粗估）`
          : '上下文提醒：关',
      );
      lines.push(rhythm.handoffReminder ? '交接后提醒补写：开' : '交接后提醒补写：关');
      const m = rhythm.maintenance;
      if (!m.enabled) lines.push('自动归档：关');
      else {
        const parts = [`${m.ageDays} 天没取用且重要度 ≤ ${m.importance}`];
        if (m.conflicts) parts.push(`内容重复度 ≥ ${Math.round(m.similarity * 100)}% 的旧条目`);
        parts.push('置顶与重要度 5 不自动动');
        const tail = m.lastRunAt ? `｜上次 ${when(m.lastRunAt)} 归档 ${m.lastArchived} 条（累计 ${m.totalArchived}）` : '｜还没跑过';
        lines.push(`自动归档：${parts.join('；')}${tail}`);
      }
      if (rhythm.lastReminder) {
        const kind = rhythm.lastReminder.kind === 'schedule' ? '定时' : rhythm.lastReminder.kind === 'context' ? '上下文' : '交接';
        lines.push(`最近一次提醒：${when(rhythm.lastReminder.at)}（${kind}）`);
      }
      if (m.sample.length) lines.push(`上次自动归档：${m.sample.map((item) => item.reason).join('；')}`);
      rhythmBody.replaceChildren(...lines.map((line) => ui.h('div', 'muted', line)));
      rhythmBody.style.cssText = 'font-size:12px;line-height:1.7;';
    };

    const renderSnapshot = (snapshot: LibrarySnapshot): void => {
      renderRhythm(snapshot.rhythm);
      stats.replaceChildren(
        ui.stat({ k: '未归档', v: snapshot.counts.live, unit: '条', accent: true }),
        ui.stat({ k: '归档', v: snapshot.counts.archived, unit: '条' }),
        ui.stat({ k: '置顶', v: snapshot.counts.pinned, unit: '条' }),
        ui.stat({ k: '过期待整理', v: snapshot.expired.count, unit: '条' }),
        ui.stat({ k: '容量上限', v: snapshot.limit, unit: '条' }),
      );
      embedLine.textContent = snapshot.embed.enabled
        ? `语义检索：${snapshot.embed.state === 'ready' ? '就绪' : snapshot.embed.state === 'partial' ? `部分就绪（${snapshot.embed.indexed}/${snapshot.embed.live} 条有向量）` : snapshot.embed.state === 'error' ? `出错（${snapshot.embed.lastError ?? '未知'}）` : '开了但没配好'} · ${snapshot.embed.model}`
        : '语义检索：关（只用字面匹配）。到「嵌入」页签可以接上本地或云端的嵌入模型。';
      embedLine.classList.toggle('bad', snapshot.embed.state === 'error');
      const kinds = snapshot.kinds.map((item) => `${item.label} ${item.count}`).join(' · ');
      const tags = snapshot.tags.length ? snapshot.tags.map((item) => `${item.tag}(${item.count})`).join('、') : '（还没有标签）';
      note.textContent = `种类：${kinds}｜标签：${tags}｜过期待整理 ${snapshot.expired.count} 条｜存档：${snapshot.storeFile}`;
      renderRows(snapshot.recent);
      if (snapshot.recent.length) {
        msg.textContent = `最近修订的 ${snapshot.recent.length} 条。`;
        msg.classList.remove('bad');
      } else {
        msg.textContent = '记忆库还是空的：让模型用 ink_remember 写第一条。';
      }
    };

    const load = async (recent = false): Promise<void> => {
      const busy = ui.busy('读取记忆库');
      try {
        const result = await ctx.invoke<PanelResult<LibrarySnapshot>>('snapshot');
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? '读取失败';
          msg.classList.add('bad');
          table.clear('读取失败。');
          return;
        }
        renderSnapshot(result.data);
        if (recent) {
          query.value = '';
          tag.value = '';
          kind.value = '';
          archived.setChecked(false);
        }
      } catch (error) {
        msg.textContent = textOf(error);
        msg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const run = async (): Promise<void> => {
      if (!query.value.trim() && !tag.value.trim() && !kind.value && !archived.checked) {
        ui.toast('给一个关键词，或勾「含归档」看全部', 'bad');
        return;
      }
      const busy = ui.busy('检索中');
      msg.textContent = '检索中…';
      msg.classList.remove('bad');
      try {
        const result = await ctx.invoke<PanelResult<SearchResponse>>('search', [
          {
            query: query.value,
            tag: tag.value,
            kind: kind.value,
            includeArchived: archived.checked,
            limit: 30,
          },
        ]);
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? '检索失败';
          msg.classList.add('bad');
          table.clear('检索失败。');
          return;
        }
        const data = result.data;
        renderRows(data.hits);
        if (!data.hits.length) {
          msg.textContent = data.hint ?? (data.degraded ? `没有命中；语义检索这次没连上（${data.degraded}）` : '没有命中。');
          return;
        }
        msg.textContent = `${data.hits.length} 条${data.semantic ? '（含语义）' : ''}｜${data.plan}${data.degraded ? `｜语义未连上：${data.degraded}` : ''}`;
        if (data.degraded) msg.classList.add('bad');
      } catch (error) {
        msg.textContent = textOf(error);
        msg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    await load();
  },
};

export default panel;
