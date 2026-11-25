/**
 * 「嵌入」页签：引导人类给记忆库接一个嵌入模型。
 *
 * 三件事分开做，免得一次填一堆：
 * 1. 选供应商预设（OpenAI / Ollama / LM Studio / 自定义）→ 只填地址与模型名；
 * 2. 密钥单独一张卡，写进部署 .env，不落 config.json；
 * 3. 限流与预算单独一张卡，防止 429 与烧额度。
 *
 * 所有保存都走 `worlds.thepalestink.*` 热配置，保存即生效；没有「重启」按钮。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type {
  EmbeddingStatus,
  PanelResult,
  ProbeResponse,
  ReindexResponse,
  SaveResponse,
  SecretResponse,
} from '../panel-types.ts';

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state: string): { text: string; tone: 'on' | 'off' | 'plain' } {
  switch (state) {
    case 'ready':
      return { text: '就绪', tone: 'on' };
    case 'partial':
      return { text: '部分就绪', tone: 'plain' };
    case 'error':
      return { text: '出错', tone: 'off' };
    case 'unconfigured':
      return { text: '未配置', tone: 'off' };
    default:
      return { text: '关', tone: 'off' };
  }
}

function numberInput(ctx: WebUiPanelContext, value: number, hint: string): HTMLInputElement {
  const input = ctx.ui.input({ type: 'number', value: String(value) });
  input.title = hint;
  return input;
}

const panel: WebUiPanel = {
  async mount(ctx) {
    const ui = ctx.ui;
    let status: EmbeddingStatus | null = null;

    const head = ui.sheet({
      title: '嵌入',
      en: 'Embeddings',
      desc: '可选功能：接上以后，检索除了字面命中，还会按「意思相近」找。接不上时自动退回字面匹配，不会让检索失败。',
    });
    ctx.root.append(head.el);

    const statePill = ui.h('span');
    const stats = ui.statgrid();
    const statusMsg = ui.msgline();
    const headBar = ui.rowbar();
    const probeBtn = ui.button('测试连接', { variant: 'primary', onClick: () => void probe() });
    const reindexBtn = ui.button('重建向量', { onClick: () => void reindex() });
    const refreshBtn = ui.button('刷新', { onClick: () => void refresh() });
    headBar.append(statePill, probeBtn, reindexBtn, refreshBtn);
    head.body.append(headBar, stats, statusMsg);

    // ---- 供应商预设 -------------------------------------------------------
    const presetSheet = ui.sheet({
      title: '供应商',
      desc: '先选一个预设，地址与模型名会填好；再按需改。选「自定义」可接任何 OpenAI 兼容端点。',
    });
    const presetBar = ui.rowbar();
    const presetSelect = ui.select({ options: [] as Array<{ value: string; label: string }> });
    const applyPreset = ui.button('套用', {
      size: 'sm',
      onClick: () => {
        const preset = status?.presets.find((item) => item.id === presetSelect.value);
        if (!preset) return;
        protocol.value = preset.protocol;
        baseUrl.value = preset.baseUrl;
        model.value = preset.model;
        dims.value = String(preset.dimensions);
        presetNote.textContent = preset.note;
        if (preset.needsKey) {
          secretNote.textContent = `这个供应商要密钥：填在下面「密钥」卡里（环境变量 ${secretName.value || 'THEPALESTINK_EMBED_KEY'}）。`;
        } else {
          secretNote.textContent = '本地模型一般不需要密钥，留空即可。';
        }
      },
    });
    presetBar.append(presetSelect, applyPreset);
    const presetNote = ui.h('div', 'muted', '');
    presetNote.style.fontSize = '12px';
    presetNote.style.marginTop = '6px';
    presetSheet.body.append(presetBar, presetNote);

    // ---- 接口与开关 -------------------------------------------------------
    const formSheet = ui.sheet({
      title: '接口与开关',
      desc: '保存后立即生效（热配置）。换模型、协议或地址等于换向量空间，已存的向量会自动作废重算。',
    });
    const semanticBox = ui.checkbox('打开语义检索', {
      title: '关掉时只用字面匹配；打开后每次检索多一次嵌入调用（受下面的限流与预算约束）。',
    });
    const protocol = ui.select({
      options: [
        { value: 'openai', label: 'OpenAI 兼容（/v1/embeddings）' },
        { value: 'ollama', label: 'Ollama（/api/embed）' },
      ],
    });
    const baseUrl = ui.input({ placeholder: 'https://api.openai.com/v1 或 http://127.0.0.1:11434' });
    const model = ui.input({ placeholder: 'text-embedding-3-small / nomic-embed-text' });
    const dims = numberInput(ctx, 0, '0 = 跟随模型返回；填了就必须与模型输出一致。');
    const weight = numberInput(ctx, 0.45, '0–1。越大越偏「意思」，越小越偏字面。建议 0.3–0.6。');
    const secretName = ui.input({ placeholder: 'THEPALESTINK_EMBED_KEY' });
    secretName.title = '只写环境变量名；密钥本身在下面的「密钥」卡里填，写进部署 .env。';

    formSheet.body.append(
      semanticBox.el,
      ui.field('协议', protocol),
      ui.field('接口地址', baseUrl),
      ui.field('模型', model),
      ui.field('向量维度', dims),
      ui.field('语义权重', weight),
      ui.field('密钥的环境变量名', secretName),
    );

    // ---- 限流与预算 -------------------------------------------------------
    const limitSheet = ui.sheet({
      title: '限流与预算',
      desc: '这些参数是为了不把接口打爆、也不把额度烧光。第一次用云端 API 时建议从保守值开始。',
    });
    const batch = numberInput(ctx, 16, '一次请求带几条文本；本地小模型建议 8–16。');
    const timeout = numberInput(ctx, 20000, '单次请求超时（毫秒）。超时按失败计。');
    const concurrency = numberInput(ctx, 1, '同时在飞的请求数；免费额度或本地模型建议 1。');
    const rpm = numberInput(ctx, 60, '每分钟最多多少次请求（一批算一次）。超了就排队。');
    const retries = numberInput(ctx, 2, '遇到 429 / 5xx / 网络错误时重试几次，指数退避并尊重 Retry-After。');
    const budget = numberInput(ctx, 2000, '每天最多多少次请求；0 = 不限制。用超后语义检索退回字面模式。');
    const autoReindex = ui.checkbox('启用或换模型后自动补向量', {
      title: '启动时给还没向量化的条目补上，受批量、限流与每日预算约束。',
    });
    limitSheet.body.append(
      ui.field('批量大小', batch),
      ui.field('超时（毫秒）', timeout),
      ui.field('并发请求数', concurrency),
      ui.field('每分钟请求上限', rpm),
      ui.field('失败重试次数', retries),
      ui.field('每日请求预算', budget),
      autoReindex.el,
    );

    const formMsg = ui.msgline();
    const formBar = ui.actions();
    const saveBtn = ui.button('保存设置', {
      variant: 'primary',
      onClick: () => void saveSettings([semanticBox, protocol, baseUrl, model, dims, weight, secretName]),
    });
    formBar.append(saveBtn);
    formSheet.body.append(formMsg, formBar);

    // ---- 密钥 -------------------------------------------------------------
    const secretSheet = ui.sheet({
      title: '密钥',
      desc: '只写进部署目录的 .env（仅你本人可读），不落 config.json，也不会出现在日志与面板回显里。本地模型可留空。',
    });
    const secretInput = ui.input({ type: 'password', placeholder: '粘贴 API 密钥' });
    const secretNote = ui.h('div', 'muted', '');
    secretNote.style.fontSize = '12px';
    const secretBar = ui.actions();
    const saveSecretBtn = ui.button('保存密钥', {
      onClick: () => {
        const value = secretInput.value.trim();
        if (!value) {
          ui.toast('密钥不能为空', 'bad');
          return;
        }
        void (async () => {
          const busy = ui.busy('保存密钥');
          try {
            const result = await ctx.invoke<PanelResult<SecretResponse>>('save-secret', [{ secret: value }]);
            if (!result.ok || !result.data) {
              secretNote.textContent = result.error ?? '保存失败';
              secretNote.classList.add('bad');
              ui.toast(result.error ?? '保存失败', 'bad');
              return;
            }
            secretInput.value = '';
            secretNote.classList.remove('bad');
            secretNote.textContent = `已写入部署 .env 的 ${result.data.name}；下次检索就会带上它。`;
            ui.toast('密钥已保存', 'ok');
            await refresh();
          } catch (error) {
            secretNote.textContent = textOf(error);
            secretNote.classList.add('bad');
          } finally {
            busy.dispose();
          }
        })();
      },
    });
    secretBar.append(saveSecretBtn);
    secretSheet.body.append(secretInput, secretNote, secretBar);

    // ---- 读取与渲染 -------------------------------------------------------
    const applyStatus = (next: EmbeddingStatus): void => {
      status = next;
      const label = stateLabel(next.state);
      statePill.replaceChildren(ui.pill(`语义检索：${label.text}`, label.tone));
      stats.replaceChildren(
        ui.stat({ k: '已向量化', v: next.indexed, unit: `/ ${next.live} 条`, accent: next.state === 'ready' }),
        ui.stat({ k: '向量维度', v: next.dims || '—' }),
        ui.stat({ k: '今日请求', v: next.usage.calls, unit: next.usage.budget ? `/ ${next.usage.budget}` : '' }),
        ui.stat({ k: '累计请求', v: next.usage.totalCalls, unit: '次' }),
      );
      const parts: string[] = [`模型：${next.model || '（未填）'}`, `地址：${next.target || '（未填）'}`];
      if (next.lastError) parts.push(`最近一次失败：${next.lastError}`);
      statusMsg.textContent = parts.join('｜');
      statusMsg.classList.toggle('bad', Boolean(next.lastError));

      const s = next.settings;
      semanticBox.setChecked(s.semanticEnabled);
      protocol.value = s.protocol;
      baseUrl.value = s.baseUrl;
      model.value = s.model;
      dims.value = String(s.dimensions);
      weight.value = String(s.semanticWeight);
      secretName.value = s.apiKeySecret;
      batch.value = String(s.batchSize);
      timeout.value = String(s.timeoutMs);
      concurrency.value = String(s.concurrency);
      rpm.value = String(s.requestsPerMinute);
      retries.value = String(s.maxRetries);
      budget.value = String(s.dailyBudget);
      autoReindex.setChecked(s.autoReindex);

      presetSelect.replaceChildren(
        ...next.presets.map((preset) => {
          const option = document.createElement('option');
          option.value = preset.id;
          option.textContent = preset.label;
          return option;
        }),
      );
      secretNote.textContent = next.hasKey
        ? `已经存了密钥（${next.secretName}）；要换就重新粘贴再保存。`
        : `还没存密钥。云端供应商需要它；本地模型可以留空。环境变量名：${next.secretName}。`;
      secretNote.classList.remove('bad');
    };

    const refresh = async (): Promise<void> => {
      const busy = ui.busy('读取嵌入状态');
      try {
        const result = await ctx.invoke<PanelResult<EmbeddingStatus>>('status');
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? '读取失败';
          statusMsg.classList.add('bad');
          return;
        }
        applyStatus(result.data);
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const saveSettings = async (fields: Array<HTMLInputElement | HTMLSelectElement | ReturnType<typeof ui.checkbox>>): Promise<void> => {
      const busy = ui.busy('保存设置');
      formMsg.classList.remove('bad');
      formMsg.textContent = '保存中…';
      try {
        const patch = {
          semanticEnabled: semanticBox.checked,
          autoReindex: autoReindex.checked,
          protocol: protocol.value,
          baseUrl: baseUrl.value.trim(),
          model: model.value.trim(),
          dimensions: Number(dims.value || 0),
          semanticWeight: Number(weight.value || 0),
          apiKeySecret: secretName.value.trim(),
          batchSize: Number(batch.value || 16),
          timeoutMs: Number(timeout.value || 20000),
          concurrency: Number(concurrency.value || 1),
          requestsPerMinute: Number(rpm.value || 60),
          maxRetries: Number(retries.value || 0),
          dailyBudget: Number(budget.value || 0),
        };
        void fields;
        const result = await ctx.invoke<PanelResult<SaveResponse>>('save', [patch]);
        if (!result.ok || !result.data) {
          formMsg.textContent = result.error ?? '保存失败';
          formMsg.classList.add('bad');
          ui.toast(result.error ?? '保存失败', 'bad');
          return;
        }
        applyStatus(result.data.status);
        formMsg.textContent = `已保存：${result.data.saved.join('、')}。${result.data.status.enabled ? '语义检索已打开；点「测试连接」确认接口通。' : ''}`;
        ui.toast('已保存', 'ok');
      } catch (error) {
        formMsg.textContent = textOf(error);
        formMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const probe = async (): Promise<void> => {
      const busy = ui.busy('测试连接', '发一条最小的嵌入请求，最多等几十秒');
      try {
        const result = await ctx.invoke<PanelResult<ProbeResponse>>('probe');
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? '测试失败';
          statusMsg.classList.add('bad');
          return;
        }
        const data = result.data;
        const message = data.ok
          ? `连接正常：返回 ${data.dims} 维，用时 ${data.ms ?? '?'} 毫秒。`
          : `连接失败：${data.error ?? '未知错误'}`;
        // 先刷新状态（它会改写状态行），再把这次测试的结论放到最上面。
        await refresh();
        statusMsg.textContent = message;
        statusMsg.classList.toggle('bad', !data.ok);
        ui.toast(data.ok ? '连接正常' : '连接失败', data.ok ? 'ok' : 'bad');
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    const reindex = async (): Promise<void> => {
      const ok = await ui.confirm({
        title: '重建缺失的向量？',
        body: '只补还没向量化的条目；换过模型时先作废旧向量。会受批量、限流与每日预算约束，可能跑一阵。',
      });
      if (!ok) return;
      const busy = ui.busy('补向量中', '按批量与限流逐批发送');
      try {
        const result = await ctx.invoke<PanelResult<ReindexResponse>>('reindex');
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? '重建失败';
          statusMsg.classList.add('bad');
          return;
        }
        statusMsg.classList.remove('bad');
        statusMsg.textContent = `补向量完成：成功 ${result.data.indexed} 条${result.data.failed ? `，失败 ${result.data.failed} 条` : ''}。`;
        ui.toast('补向量完成', 'ok');
        await refresh();
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    };

    await refresh();
  },
};

export default panel;
