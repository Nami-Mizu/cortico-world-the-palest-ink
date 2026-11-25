/**
 * 「数据」页签：导出快照、从文件导入。
 *
 * 这是唯一会改存档的人工入口，所以每一步都要看得见：
 * 导出前勾「含归档」；导入先预演（会写几条、跳过几条、哪几条像重复），
 * 真正写盘前服务端还会自动备份。覆盖模式要人在「确认」框里打「替换」两个字。
 */
import type { WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import type { DataStatus, ExportResponse, ImportResponse, ImportSummary, PanelResult } from '../panel-types.ts';

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function money(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const panel: WebUiPanel = {
  async mount(ctx) {
    const ui = ctx.ui;
    const sheet = ui.sheet({
      title: '数据',
      en: 'Import / Export',
      desc: '导出一份 JSON 快照；或从快照导入。导入先预演，写盘前自动备份，不会悄悄覆盖。',
    });
    ctx.root.append(sheet.el);

    const stats = ui.statgrid();
    sheet.body.append(stats);

    const statusLine = ui.msgline();
    sheet.body.append(statusLine);

    // ---- 导出 ----
    const exportBar = ui.rowbar();
    const includeArchived = ui.checkbox('含归档条目', { checked: true });
    const exportBtn = ui.button('导出 JSON', {
      variant: 'primary',
      onClick: () => void doExport(),
    });
    exportBar.append(includeArchived.el, exportBtn);
    sheet.body.append(ui.section('导出', '快照含正文与元数据（id、时间、标签、有效期）；不含向量。'), exportBar);

    const exportMsg = ui.msgline();
    sheet.body.append(exportMsg);

    // ---- 导入 ----
    const importSection = ui.section(
      '导入',
      '合并 = 本地优先：同 id、内容几乎重复的都跳过，只补新的。覆盖 = 让本地只剩文件里那些（写盘前一定备份）。',
    );
    sheet.body.append(importSection);

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.style.cssText = 'max-width:100%;';
    const mode = ui.select({
      options: [
        { value: 'merge', label: '合并（本地优先）' },
        { value: 'replace', label: '覆盖（清空本地）' },
      ],
    });
    const confirm = ui.input({ placeholder: '覆盖导入时在这里打「替换」' });
    confirm.style.display = 'none';
    const previewBtn = ui.button('预演', {
      onClick: () => void doPreview(),
    });
    const importBtn = ui.button('执行导入', { variant: 'primary', onClick: () => void doImport() });
    importBtn.disabled = true;
    const importBar = ui.rowbar();
    importBar.append(file, mode, confirm, previewBtn, importBtn);
    importSection.append(importBar);

    const importMsg = ui.msgline();
    importSection.append(importMsg);

    const previewBox = ui.h('div');
    previewBox.style.cssText = 'margin-top:10px;';
    importSection.append(previewBox);

    let payload = '';
    let previewMode: 'merge' | 'replace' | '' = '';

    const renderStatus = (data: DataStatus): void => {
      stats.replaceChildren(
        ui.stat({ k: '未归档', v: data.counts.live, unit: '条', accent: true }),
        ui.stat({ k: '已归档', v: data.counts.archived, unit: '条' }),
        ui.stat({ k: '存档大小', v: money(data.entriesBytes) }),
        ui.stat({ k: '向量', v: data.vectorCount, unit: '条' }),
      );
      statusLine.textContent = `存档：${data.storeFile}｜向量：${data.vectorFile}`;
      statusLine.title = statusLine.textContent;
      const bits: string[] = [];
      if (data.lastImportAt) bits.push(`上次导入 ${data.lastImportAt.slice(0, 16).replace('T', ' ')}`);
      if (data.lastBackup) bits.push(`备份 ${data.lastBackup}`);
      if (data.expired) bits.push(`过期待整理 ${data.expired} 条`);
      if (bits.length) exportMsg.textContent = bits.join('｜');
    };

    const refresh = async (): Promise<void> => {
      try {
        const result = await ctx.invoke<PanelResult<DataStatus>>('status', []);
        if (!result.ok || !result.data) throw new Error(result.error ?? '读不到状态。');
        renderStatus(result.data);
      } catch (error) {
        statusLine.textContent = `读状态失败：${textOf(error)}`;
        statusLine.classList.add('bad');
      }
    };

    const doExport = async (): Promise<void> => {
      const busy = ui.busy('导出', '打包快照');
      try {
        const result = await ctx.invoke<PanelResult<ExportResponse>>('export', [
          { includeArchived: includeArchived.checked },
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? '导出失败。');
        const data = result.data;
        download(data.filename, data.json);
        exportMsg.textContent = `已导出 ${data.exported} 条（归档 ${data.archived} 条，${money(data.bytes)}）：${data.filename}`;
        exportMsg.classList.remove('bad');
      } catch (error) {
        exportMsg.textContent = `导出失败：${textOf(error)}`;
        exportMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const renderPreview = (data: ImportSummary): void => {
      previewBox.replaceChildren();
      const head = ui.h(
        'div',
        undefined,
        `预演：文件 ${data.incoming} 条 → 会写 ${data.added} 条，同 id 跳过 ${data.skipped} 条，内容重复跳过 ${data.duplicateCount} 条，无效 ${data.invalid} 条。`,
      );
      head.style.marginBottom = '6px';
      previewBox.append(head);
      if (data.duplicates.length) {
        const dupTitle = ui.h('div', 'muted', '像重复的：');
        dupTitle.style.fontSize = '12px';
        previewBox.append(dupTitle);
        const list = ui.log({ max: 8, maxHeight: '140px', empty: '（没有）' });
        for (const item of data.duplicates) list.append(`${item.id} ≈ ${item.of}（${item.similarity}%）`);
        previewBox.append(list.el);
      }
      if (data.samples.length) {
        const sampleTitle = ui.h('div', 'muted', '会写进去的：');
        sampleTitle.style.fontSize = '12px';
        previewBox.append(sampleTitle);
        const list = ui.log({ max: 8, maxHeight: '160px', empty: '（没有）' });
        for (const item of data.samples) list.append(`${item.id}：${item.text}`);
        previewBox.append(list.el);
      }
    };

    const doPreview = async (): Promise<void> => {
      const chosen = file.files?.[0];
      if (!chosen) {
        importMsg.textContent = '先选一个 JSON 快照文件。';
        importMsg.classList.add('bad');
        return;
      }
      const busy = ui.busy('预演', chosen.name);
      try {
        payload = await chosen.text();
        previewMode = mode.value === 'replace' ? 'replace' : 'merge';
        const result = await ctx.invoke<PanelResult<ImportSummary>>('preview', [
          { json: payload, mode: previewMode },
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? '预演失败。');
        renderPreview(result.data);
        importMsg.textContent = '预演完成；确认数字后点「执行导入」。';
        importMsg.classList.remove('bad');
        importBtn.disabled = result.data.added === 0;
        confirm.style.display = previewMode === 'replace' ? '' : 'none';
      } catch (error) {
        previewBox.replaceChildren();
        importMsg.textContent = `预演失败：${textOf(error)}`;
        importMsg.classList.add('bad');
        importBtn.disabled = true;
        previewMode = '';
      } finally {
        busy.dispose();
      }
    };

    const doImport = async (): Promise<void> => {
      if (!payload || !previewMode) {
        importMsg.textContent = '先预演一次再导入。';
        importMsg.classList.add('bad');
        return;
      }
      if (previewMode === 'replace' && confirm.value.trim() !== '替换') {
        importMsg.textContent = '覆盖导入要在「确认」里输入「替换」两个字。';
        importMsg.classList.add('bad');
        confirm.focus();
        return;
      }
      const busy = ui.busy('导入', '写盘并备份');
      try {
        const result = await ctx.invoke<PanelResult<ImportResponse>>('import', [
          { json: payload, mode: previewMode, confirm: confirm.value.trim() },
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? '导入失败。');
        const data = result.data;
        importMsg.textContent = data.note
          ? data.note
          : `已导入 ${data.imported} 条（跳过 ${data.skipped}，重复 ${data.duplicateCount}，无效 ${data.invalid}）。${data.backup ? `备份：${data.backup}` : ''}`;
        importMsg.classList.remove('bad');
        previewBox.replaceChildren();
        importBtn.disabled = true;
        payload = '';
        previewMode = '';
        file.value = '';
        confirm.value = '';
        await refresh();
      } catch (error) {
        importMsg.textContent = `导入失败：${textOf(error)}`;
        importMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    mode.addEventListener('change', () => {
      confirm.style.display = mode.value === 'replace' ? '' : 'none';
      importBtn.disabled = true;
      previewMode = '';
    });

    await refresh();
  },
};

export default panel;
