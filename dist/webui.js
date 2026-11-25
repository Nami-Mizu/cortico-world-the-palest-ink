// src/webui/panels/embedding.ts
function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function stateLabel(state) {
  switch (state) {
    case "ready":
      return { text: "\u5C31\u7EEA", tone: "on" };
    case "partial":
      return { text: "\u90E8\u5206\u5C31\u7EEA", tone: "plain" };
    case "error":
      return { text: "\u51FA\u9519", tone: "off" };
    case "unconfigured":
      return { text: "\u672A\u914D\u7F6E", tone: "off" };
    default:
      return { text: "\u5173", tone: "off" };
  }
}
function numberInput(ctx, value, hint) {
  const input = ctx.ui.input({ type: "number", value: String(value) });
  input.title = hint;
  return input;
}
var panel = {
  async mount(ctx) {
    const ui = ctx.ui;
    let status = null;
    const head = ui.sheet({
      title: "\u5D4C\u5165",
      en: "Embeddings",
      desc: "\u53EF\u9009\u529F\u80FD\uFF1A\u63A5\u4E0A\u4EE5\u540E\uFF0C\u68C0\u7D22\u9664\u4E86\u5B57\u9762\u547D\u4E2D\uFF0C\u8FD8\u4F1A\u6309\u300C\u610F\u601D\u76F8\u8FD1\u300D\u627E\u3002\u63A5\u4E0D\u4E0A\u65F6\u81EA\u52A8\u9000\u56DE\u5B57\u9762\u5339\u914D\uFF0C\u4E0D\u4F1A\u8BA9\u68C0\u7D22\u5931\u8D25\u3002"
    });
    ctx.root.append(head.el);
    const statePill = ui.h("span");
    const stats = ui.statgrid();
    const statusMsg = ui.msgline();
    const headBar = ui.rowbar();
    const probeBtn = ui.button("\u6D4B\u8BD5\u8FDE\u63A5", { variant: "primary", onClick: () => void probe() });
    const reindexBtn = ui.button("\u91CD\u5EFA\u5411\u91CF", { onClick: () => void reindex() });
    const refreshBtn = ui.button("\u5237\u65B0", { onClick: () => void refresh() });
    headBar.append(statePill, probeBtn, reindexBtn, refreshBtn);
    head.body.append(headBar, stats, statusMsg);
    const presetSheet = ui.sheet({
      title: "\u4F9B\u5E94\u5546",
      desc: "\u5148\u9009\u4E00\u4E2A\u9884\u8BBE\uFF0C\u5730\u5740\u4E0E\u6A21\u578B\u540D\u4F1A\u586B\u597D\uFF1B\u518D\u6309\u9700\u6539\u3002\u9009\u300C\u81EA\u5B9A\u4E49\u300D\u53EF\u63A5\u4EFB\u4F55 OpenAI \u517C\u5BB9\u7AEF\u70B9\u3002"
    });
    const presetBar = ui.rowbar();
    const presetSelect = ui.select({ options: [] });
    const applyPreset = ui.button("\u5957\u7528", {
      size: "sm",
      onClick: () => {
        const preset = status?.presets.find((item) => item.id === presetSelect.value);
        if (!preset) return;
        protocol.value = preset.protocol;
        baseUrl.value = preset.baseUrl;
        model.value = preset.model;
        dims.value = String(preset.dimensions);
        presetNote.textContent = preset.note;
        if (preset.needsKey) {
          secretNote.textContent = `\u8FD9\u4E2A\u4F9B\u5E94\u5546\u8981\u5BC6\u94A5\uFF1A\u586B\u5728\u4E0B\u9762\u300C\u5BC6\u94A5\u300D\u5361\u91CC\uFF08\u73AF\u5883\u53D8\u91CF ${secretName.value || "THEPALESTINK_EMBED_KEY"}\uFF09\u3002`;
        } else {
          secretNote.textContent = "\u672C\u5730\u6A21\u578B\u4E00\u822C\u4E0D\u9700\u8981\u5BC6\u94A5\uFF0C\u7559\u7A7A\u5373\u53EF\u3002";
        }
      }
    });
    presetBar.append(presetSelect, applyPreset);
    const presetNote = ui.h("div", "muted", "");
    presetNote.style.fontSize = "12px";
    presetNote.style.marginTop = "6px";
    presetSheet.body.append(presetBar, presetNote);
    const formSheet = ui.sheet({
      title: "\u63A5\u53E3\u4E0E\u5F00\u5173",
      desc: "\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\uFF08\u70ED\u914D\u7F6E\uFF09\u3002\u6362\u6A21\u578B\u3001\u534F\u8BAE\u6216\u5730\u5740\u7B49\u4E8E\u6362\u5411\u91CF\u7A7A\u95F4\uFF0C\u5DF2\u5B58\u7684\u5411\u91CF\u4F1A\u81EA\u52A8\u4F5C\u5E9F\u91CD\u7B97\u3002"
    });
    const semanticBox = ui.checkbox("\u6253\u5F00\u8BED\u4E49\u68C0\u7D22", {
      title: "\u5173\u6389\u65F6\u53EA\u7528\u5B57\u9762\u5339\u914D\uFF1B\u6253\u5F00\u540E\u6BCF\u6B21\u68C0\u7D22\u591A\u4E00\u6B21\u5D4C\u5165\u8C03\u7528\uFF08\u53D7\u4E0B\u9762\u7684\u9650\u6D41\u4E0E\u9884\u7B97\u7EA6\u675F\uFF09\u3002"
    });
    const protocol = ui.select({
      options: [
        { value: "openai", label: "OpenAI \u517C\u5BB9\uFF08/v1/embeddings\uFF09" },
        { value: "ollama", label: "Ollama\uFF08/api/embed\uFF09" }
      ]
    });
    const baseUrl = ui.input({ placeholder: "https://api.openai.com/v1 \u6216 http://127.0.0.1:11434" });
    const model = ui.input({ placeholder: "text-embedding-3-small / nomic-embed-text" });
    const dims = numberInput(ctx, 0, "0 = \u8DDF\u968F\u6A21\u578B\u8FD4\u56DE\uFF1B\u586B\u4E86\u5C31\u5FC5\u987B\u4E0E\u6A21\u578B\u8F93\u51FA\u4E00\u81F4\u3002");
    const weight = numberInput(ctx, 0.45, "0\u20131\u3002\u8D8A\u5927\u8D8A\u504F\u300C\u610F\u601D\u300D\uFF0C\u8D8A\u5C0F\u8D8A\u504F\u5B57\u9762\u3002\u5EFA\u8BAE 0.3\u20130.6\u3002");
    const secretName = ui.input({ placeholder: "THEPALESTINK_EMBED_KEY" });
    secretName.title = "\u53EA\u5199\u73AF\u5883\u53D8\u91CF\u540D\uFF1B\u5BC6\u94A5\u672C\u8EAB\u5728\u4E0B\u9762\u7684\u300C\u5BC6\u94A5\u300D\u5361\u91CC\u586B\uFF0C\u5199\u8FDB\u90E8\u7F72 .env\u3002";
    formSheet.body.append(
      semanticBox.el,
      ui.field("\u534F\u8BAE", protocol),
      ui.field("\u63A5\u53E3\u5730\u5740", baseUrl),
      ui.field("\u6A21\u578B", model),
      ui.field("\u5411\u91CF\u7EF4\u5EA6", dims),
      ui.field("\u8BED\u4E49\u6743\u91CD", weight),
      ui.field("\u5BC6\u94A5\u7684\u73AF\u5883\u53D8\u91CF\u540D", secretName)
    );
    const limitSheet = ui.sheet({
      title: "\u9650\u6D41\u4E0E\u9884\u7B97",
      desc: "\u8FD9\u4E9B\u53C2\u6570\u662F\u4E3A\u4E86\u4E0D\u628A\u63A5\u53E3\u6253\u7206\u3001\u4E5F\u4E0D\u628A\u989D\u5EA6\u70E7\u5149\u3002\u7B2C\u4E00\u6B21\u7528\u4E91\u7AEF API \u65F6\u5EFA\u8BAE\u4ECE\u4FDD\u5B88\u503C\u5F00\u59CB\u3002"
    });
    const batch = numberInput(ctx, 16, "\u4E00\u6B21\u8BF7\u6C42\u5E26\u51E0\u6761\u6587\u672C\uFF1B\u672C\u5730\u5C0F\u6A21\u578B\u5EFA\u8BAE 8\u201316\u3002");
    const timeout = numberInput(ctx, 2e4, "\u5355\u6B21\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09\u3002\u8D85\u65F6\u6309\u5931\u8D25\u8BA1\u3002");
    const concurrency = numberInput(ctx, 1, "\u540C\u65F6\u5728\u98DE\u7684\u8BF7\u6C42\u6570\uFF1B\u514D\u8D39\u989D\u5EA6\u6216\u672C\u5730\u6A21\u578B\u5EFA\u8BAE 1\u3002");
    const rpm = numberInput(ctx, 60, "\u6BCF\u5206\u949F\u6700\u591A\u591A\u5C11\u6B21\u8BF7\u6C42\uFF08\u4E00\u6279\u7B97\u4E00\u6B21\uFF09\u3002\u8D85\u4E86\u5C31\u6392\u961F\u3002");
    const retries = numberInput(ctx, 2, "\u9047\u5230 429 / 5xx / \u7F51\u7EDC\u9519\u8BEF\u65F6\u91CD\u8BD5\u51E0\u6B21\uFF0C\u6307\u6570\u9000\u907F\u5E76\u5C0A\u91CD Retry-After\u3002");
    const budget = numberInput(ctx, 2e3, "\u6BCF\u5929\u6700\u591A\u591A\u5C11\u6B21\u8BF7\u6C42\uFF1B0 = \u4E0D\u9650\u5236\u3002\u7528\u8D85\u540E\u8BED\u4E49\u68C0\u7D22\u9000\u56DE\u5B57\u9762\u6A21\u5F0F\u3002");
    const autoReindex = ui.checkbox("\u542F\u7528\u6216\u6362\u6A21\u578B\u540E\u81EA\u52A8\u8865\u5411\u91CF", {
      title: "\u542F\u52A8\u65F6\u7ED9\u8FD8\u6CA1\u5411\u91CF\u5316\u7684\u6761\u76EE\u8865\u4E0A\uFF0C\u53D7\u6279\u91CF\u3001\u9650\u6D41\u4E0E\u6BCF\u65E5\u9884\u7B97\u7EA6\u675F\u3002"
    });
    limitSheet.body.append(
      ui.field("\u6279\u91CF\u5927\u5C0F", batch),
      ui.field("\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", timeout),
      ui.field("\u5E76\u53D1\u8BF7\u6C42\u6570", concurrency),
      ui.field("\u6BCF\u5206\u949F\u8BF7\u6C42\u4E0A\u9650", rpm),
      ui.field("\u5931\u8D25\u91CD\u8BD5\u6B21\u6570", retries),
      ui.field("\u6BCF\u65E5\u8BF7\u6C42\u9884\u7B97", budget),
      autoReindex.el
    );
    const formMsg = ui.msgline();
    const formBar = ui.actions();
    const saveBtn = ui.button("\u4FDD\u5B58\u8BBE\u7F6E", {
      variant: "primary",
      onClick: () => void saveSettings([semanticBox, protocol, baseUrl, model, dims, weight, secretName])
    });
    formBar.append(saveBtn);
    formSheet.body.append(formMsg, formBar);
    const secretSheet = ui.sheet({
      title: "\u5BC6\u94A5",
      desc: "\u53EA\u5199\u8FDB\u90E8\u7F72\u76EE\u5F55\u7684 .env\uFF08\u4EC5\u4F60\u672C\u4EBA\u53EF\u8BFB\uFF09\uFF0C\u4E0D\u843D config.json\uFF0C\u4E5F\u4E0D\u4F1A\u51FA\u73B0\u5728\u65E5\u5FD7\u4E0E\u9762\u677F\u56DE\u663E\u91CC\u3002\u672C\u5730\u6A21\u578B\u53EF\u7559\u7A7A\u3002"
    });
    const secretInput = ui.input({ type: "password", placeholder: "\u7C98\u8D34 API \u5BC6\u94A5" });
    const secretNote = ui.h("div", "muted", "");
    secretNote.style.fontSize = "12px";
    const secretBar = ui.actions();
    const saveSecretBtn = ui.button("\u4FDD\u5B58\u5BC6\u94A5", {
      onClick: () => {
        const value = secretInput.value.trim();
        if (!value) {
          ui.toast("\u5BC6\u94A5\u4E0D\u80FD\u4E3A\u7A7A", "bad");
          return;
        }
        void (async () => {
          const busy = ui.busy("\u4FDD\u5B58\u5BC6\u94A5");
          try {
            const result = await ctx.invoke("save-secret", [{ secret: value }]);
            if (!result.ok || !result.data) {
              secretNote.textContent = result.error ?? "\u4FDD\u5B58\u5931\u8D25";
              secretNote.classList.add("bad");
              ui.toast(result.error ?? "\u4FDD\u5B58\u5931\u8D25", "bad");
              return;
            }
            secretInput.value = "";
            secretNote.classList.remove("bad");
            secretNote.textContent = `\u5DF2\u5199\u5165\u90E8\u7F72 .env \u7684 ${result.data.name}\uFF1B\u4E0B\u6B21\u68C0\u7D22\u5C31\u4F1A\u5E26\u4E0A\u5B83\u3002`;
            ui.toast("\u5BC6\u94A5\u5DF2\u4FDD\u5B58", "ok");
            await refresh();
          } catch (error) {
            secretNote.textContent = textOf(error);
            secretNote.classList.add("bad");
          } finally {
            busy.dispose();
          }
        })();
      }
    });
    secretBar.append(saveSecretBtn);
    secretSheet.body.append(secretInput, secretNote, secretBar);
    const applyStatus = (next) => {
      status = next;
      const label = stateLabel(next.state);
      statePill.replaceChildren(ui.pill(`\u8BED\u4E49\u68C0\u7D22\uFF1A${label.text}`, label.tone));
      stats.replaceChildren(
        ui.stat({ k: "\u5DF2\u5411\u91CF\u5316", v: next.indexed, unit: `/ ${next.live} \u6761`, accent: next.state === "ready" }),
        ui.stat({ k: "\u5411\u91CF\u7EF4\u5EA6", v: next.dims || "\u2014" }),
        ui.stat({ k: "\u4ECA\u65E5\u8BF7\u6C42", v: next.usage.calls, unit: next.usage.budget ? `/ ${next.usage.budget}` : "" }),
        ui.stat({ k: "\u7D2F\u8BA1\u8BF7\u6C42", v: next.usage.totalCalls, unit: "\u6B21" })
      );
      const parts = [`\u6A21\u578B\uFF1A${next.model || "\uFF08\u672A\u586B\uFF09"}`, `\u5730\u5740\uFF1A${next.target || "\uFF08\u672A\u586B\uFF09"}`];
      if (next.lastError) parts.push(`\u6700\u8FD1\u4E00\u6B21\u5931\u8D25\uFF1A${next.lastError}`);
      statusMsg.textContent = parts.join("\uFF5C");
      statusMsg.classList.toggle("bad", Boolean(next.lastError));
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
          const option = document.createElement("option");
          option.value = preset.id;
          option.textContent = preset.label;
          return option;
        })
      );
      secretNote.textContent = next.hasKey ? `\u5DF2\u7ECF\u5B58\u4E86\u5BC6\u94A5\uFF08${next.secretName}\uFF09\uFF1B\u8981\u6362\u5C31\u91CD\u65B0\u7C98\u8D34\u518D\u4FDD\u5B58\u3002` : `\u8FD8\u6CA1\u5B58\u5BC6\u94A5\u3002\u4E91\u7AEF\u4F9B\u5E94\u5546\u9700\u8981\u5B83\uFF1B\u672C\u5730\u6A21\u578B\u53EF\u4EE5\u7559\u7A7A\u3002\u73AF\u5883\u53D8\u91CF\u540D\uFF1A${next.secretName}\u3002`;
      secretNote.classList.remove("bad");
    };
    const refresh = async () => {
      const busy = ui.busy("\u8BFB\u53D6\u5D4C\u5165\u72B6\u6001");
      try {
        const result = await ctx.invoke("status");
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? "\u8BFB\u53D6\u5931\u8D25";
          statusMsg.classList.add("bad");
          return;
        }
        applyStatus(result.data);
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const saveSettings = async (fields) => {
      const busy = ui.busy("\u4FDD\u5B58\u8BBE\u7F6E");
      formMsg.classList.remove("bad");
      formMsg.textContent = "\u4FDD\u5B58\u4E2D\u2026";
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
          timeoutMs: Number(timeout.value || 2e4),
          concurrency: Number(concurrency.value || 1),
          requestsPerMinute: Number(rpm.value || 60),
          maxRetries: Number(retries.value || 0),
          dailyBudget: Number(budget.value || 0)
        };
        void fields;
        const result = await ctx.invoke("save", [patch]);
        if (!result.ok || !result.data) {
          formMsg.textContent = result.error ?? "\u4FDD\u5B58\u5931\u8D25";
          formMsg.classList.add("bad");
          ui.toast(result.error ?? "\u4FDD\u5B58\u5931\u8D25", "bad");
          return;
        }
        applyStatus(result.data.status);
        formMsg.textContent = `\u5DF2\u4FDD\u5B58\uFF1A${result.data.saved.join("\u3001")}\u3002${result.data.status.enabled ? "\u8BED\u4E49\u68C0\u7D22\u5DF2\u6253\u5F00\uFF1B\u70B9\u300C\u6D4B\u8BD5\u8FDE\u63A5\u300D\u786E\u8BA4\u63A5\u53E3\u901A\u3002" : ""}`;
        ui.toast("\u5DF2\u4FDD\u5B58", "ok");
      } catch (error) {
        formMsg.textContent = textOf(error);
        formMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const probe = async () => {
      const busy = ui.busy("\u6D4B\u8BD5\u8FDE\u63A5", "\u53D1\u4E00\u6761\u6700\u5C0F\u7684\u5D4C\u5165\u8BF7\u6C42\uFF0C\u6700\u591A\u7B49\u51E0\u5341\u79D2");
      try {
        const result = await ctx.invoke("probe");
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? "\u6D4B\u8BD5\u5931\u8D25";
          statusMsg.classList.add("bad");
          return;
        }
        const data = result.data;
        const message = data.ok ? `\u8FDE\u63A5\u6B63\u5E38\uFF1A\u8FD4\u56DE ${data.dims} \u7EF4\uFF0C\u7528\u65F6 ${data.ms ?? "?"} \u6BEB\u79D2\u3002` : `\u8FDE\u63A5\u5931\u8D25\uFF1A${data.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
        await refresh();
        statusMsg.textContent = message;
        statusMsg.classList.toggle("bad", !data.ok);
        ui.toast(data.ok ? "\u8FDE\u63A5\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25", data.ok ? "ok" : "bad");
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const reindex = async () => {
      const ok = await ui.confirm({
        title: "\u91CD\u5EFA\u7F3A\u5931\u7684\u5411\u91CF\uFF1F",
        body: "\u53EA\u8865\u8FD8\u6CA1\u5411\u91CF\u5316\u7684\u6761\u76EE\uFF1B\u6362\u8FC7\u6A21\u578B\u65F6\u5148\u4F5C\u5E9F\u65E7\u5411\u91CF\u3002\u4F1A\u53D7\u6279\u91CF\u3001\u9650\u6D41\u4E0E\u6BCF\u65E5\u9884\u7B97\u7EA6\u675F\uFF0C\u53EF\u80FD\u8DD1\u4E00\u9635\u3002"
      });
      if (!ok) return;
      const busy = ui.busy("\u8865\u5411\u91CF\u4E2D", "\u6309\u6279\u91CF\u4E0E\u9650\u6D41\u9010\u6279\u53D1\u9001");
      try {
        const result = await ctx.invoke("reindex");
        if (!result.ok || !result.data) {
          statusMsg.textContent = result.error ?? "\u91CD\u5EFA\u5931\u8D25";
          statusMsg.classList.add("bad");
          return;
        }
        statusMsg.classList.remove("bad");
        statusMsg.textContent = `\u8865\u5411\u91CF\u5B8C\u6210\uFF1A\u6210\u529F ${result.data.indexed} \u6761${result.data.failed ? `\uFF0C\u5931\u8D25 ${result.data.failed} \u6761` : ""}\u3002`;
        ui.toast("\u8865\u5411\u91CF\u5B8C\u6210", "ok");
        await refresh();
      } catch (error) {
        statusMsg.textContent = textOf(error);
        statusMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    await refresh();
  }
};
var embedding_default = panel;

// src/webui/panels/library.ts
var KIND_OPTIONS = [
  { value: "", label: "\u5168\u90E8\u79CD\u7C7B" },
  { value: "fact", label: "\u4E8B\u5B9E" },
  { value: "event", label: "\u4E8B\u4EF6" },
  { value: "preference", label: "\u504F\u597D" },
  { value: "todo", label: "\u5F85\u529E" },
  { value: "note", label: "\u6742\u8BB0" }
];
function when(iso) {
  if (!iso) return "\u2014";
  return iso.slice(0, 16).replace("T", " ");
}
function textOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
var panel2 = {
  async mount(ctx) {
    const ui = ctx.ui;
    const sheet = ui.sheet({
      title: "\u8BB0\u5FC6\u5E93",
      en: "The Palest Ink",
      desc: "\u53EA\u8BFB\u89C6\u56FE\uFF1A\u5199\u5165\u4E0E\u4FEE\u8BA2\u7531\u6A21\u578B\u901A\u8FC7\u5DE5\u5177\u5B8C\u6210\u3002\u8FD9\u91CC\u80FD\u770B\u6E05\u5355\u3001\u6309\u5173\u952E\u8BCD\u68C0\u7D22\u3001\u8BFB\u5168\u6587\u3002"
    });
    ctx.root.append(sheet.el);
    const stats = ui.statgrid();
    const embedLine = ui.h("div", "msgline");
    sheet.body.append(stats, embedLine);
    const rhythmBox = ui.h("div");
    rhythmBox.style.cssText = "margin:10px 0;padding:10px 12px;border:1px solid rgba(128,128,128,.25);border-radius:8px;";
    const rhythmTitle = ui.h("div", "muted", "\u5199\u8BB0\u5FC6\u7684\u8282\u594F\uFF08\u53EA\u8BFB\uFF1B\u5728 World \u914D\u7F6E\u91CC\u6539\uFF09");
    rhythmTitle.style.fontSize = "12px";
    const rhythmBody = ui.h("div");
    rhythmBox.append(rhythmTitle, rhythmBody);
    sheet.body.append(rhythmBox);
    const bar = ui.rowbar();
    const query = ui.input({ type: "search", placeholder: "\u5173\u952E\u8BCD\uFF0C\u7A7A\u683C\u5206\u9694\uFF1B\u4E2D\u6587\u6309\u76F8\u90BB\u4E24\u5B57\u5339\u914D" });
    const tag = ui.input({ placeholder: "\u6807\u7B7E\uFF08\u53EF\u9009\uFF09" });
    const kind = ui.select({ options: KIND_OPTIONS });
    const archived = ui.checkbox("\u542B\u5F52\u6863");
    const submit = ui.button("\u68C0\u7D22", { variant: "primary", onClick: () => void run() });
    bar.append(query, tag, kind, archived.el, submit);
    const recentBtn = ui.button("\u770B\u6700\u8FD1", { size: "sm", onClick: () => void load(true) });
    bar.append(recentBtn);
    sheet.body.append(bar);
    const msg = ui.msgline();
    sheet.body.append(msg);
    const table = ui.table({
      head: ["\u7F16\u53F7", "\u6458\u8981", "\u79CD\u7C7B", "\u91CD\u8981\u5EA6", "\u6700\u8FD1\u4FEE\u8BA2", ""],
      maxHeight: "calc(100vh - 360px)"
    });
    sheet.body.append(table.el);
    const note = ui.h("div", "muted");
    note.style.marginTop = "10px";
    note.style.fontSize = "12px";
    sheet.body.append(note);
    const openEntry = async (id) => {
      const busy = ui.busy("\u8BFB\u53D6\u6761\u76EE", id);
      try {
        const result = await ctx.invoke("entry", [{ id }]);
        if (!result.ok || !result.data) {
          ui.toast(result.error ?? "\u8BFB\u53D6\u5931\u8D25", "bad");
          return;
        }
        const entry = result.data;
        const body = ui.h("div");
        const meta = ui.kv([
          { k: "\u7F16\u53F7", v: entry.entry.id },
          { k: "\u79CD\u7C7B", v: entry.entry.kindLabel },
          { k: "\u91CD\u8981\u5EA6", v: entry.entry.importance },
          { k: "\u6807\u7B7E", v: entry.entry.tags.length ? `#${entry.entry.tags.join(" #")}` : "\uFF08\u65E0\uFF09" },
          { k: "\u6765\u6E90", v: entry.source || "\uFF08\u672A\u5199\uFF09" },
          { k: "\u5199\u5165", v: when(entry.entry.createdAt) },
          { k: "\u4FEE\u8BA2", v: when(entry.entry.updatedAt) },
          { k: "\u53D6\u7528", v: `${entry.entry.recallCount} \u6B21${entry.lastRecalledAt ? `\uFF08\u6700\u8FD1 ${when(entry.lastRecalledAt)}\uFF09` : ""}` },
          { k: "\u5DF2\u5411\u91CF\u5316", v: entry.vectorized ? "\u662F" : "\u5426\uFF08\u8BED\u4E49\u68C0\u7D22\u627E\u4E0D\u5230\u5B83\uFF09" }
        ]);
        const text = ui.h("pre", "mono", entry.text);
        text.style.whiteSpace = "pre-wrap";
        text.style.margin = "12px 0";
        const actions = ui.actions();
        actions.append(ui.copyButton(entry.text, { label: "\u590D\u5236\u6B63\u6587" }));
        if (entry.entry.archived) {
          actions.append(ui.pill(`\u5DF2\u5F52\u6863\uFF1A${entry.archiveReason ?? "\u672A\u5199\u539F\u56E0"}`, "off"));
        }
        body.append(meta, text, actions);
        ui.drawer(`\u8BB0\u5FC6 ${entry.entry.id}`, body);
      } catch (error) {
        ui.toast(textOf2(error), "bad");
      } finally {
        busy.dispose();
      }
    };
    const renderRows = (hits) => {
      table.clear("\u6CA1\u6709\u5339\u914D\u7684\u8BB0\u5FC6\u3002\u6362\u4E2A\u8BCD\u3001\u53BB\u6389\u6807\u7B7E\uFF0C\u6216\u70B9\u300C\u770B\u6700\u8FD1\u300D\u3002");
      for (const hit of hits) {
        const flags = [hit.pinned ? "\u7F6E\u9876" : "", hit.archived ? "\u5F52\u6863" : "", hit.semantic ? "\u2248" : ""].filter(Boolean).join(" ");
        const row = table.addRow([
          hit.id.slice(0, 14),
          hit.text || hit.tags.map((item) => `#${item}`).join(" "),
          hit.kindLabel,
          String(hit.importance),
          when(hit.updatedAt),
          ui.button("\u67E5\u770B", { size: "sm", onClick: () => void openEntry(hit.id) })
        ]);
        row.addEventListener("dblclick", () => void openEntry(hit.id));
        if (flags) {
          row.title = flags;
        }
      }
    };
    const renderRhythm = (rhythm) => {
      const lines = [];
      if (!rhythm.cron) lines.push("\u5B9A\u65F6\u63D0\u9192\uFF1A\u5173\uFF08\u5728\u914D\u7F6E\u91CC\u586B cron\uFF0C\u4F8B\u5982 30 7 * * *\uFF09");
      else if (!rhythm.cronValid) lines.push(`\u5B9A\u65F6\u63D0\u9192\uFF1Acron \u5199\u9519\u4E86 \u2014\u2014 ${rhythm.cronError ?? "\u65E0\u6CD5\u89E3\u6790"}`);
      else lines.push(`\u5B9A\u65F6\u63D0\u9192\uFF1A${rhythm.cronText ?? rhythm.cron}\uFF08cron\u300C${rhythm.cron}\u300D\uFF09${rhythm.cronNextAt ? `\uFF0C\u4E0B\u6B21 ${when(rhythm.cronNextAt)}` : ""}`);
      lines.push(
        rhythm.contextPercentLimit ? `\u4E0A\u4E0B\u6587\u63D0\u9192\uFF1A\u4F30\u5230 ${rhythm.contextPercentLimit}% \u65F6\u63D0\u9192\uFF08\u73B0\u5728\u7EA6 ${rhythm.estimatedPercent ?? "\u2014"}%\uFF0C${rhythm.estimatedTokens} / ${rhythm.contextWindow ?? "\u672A\u77E5"} token\uFF0C\u7C97\u4F30\uFF09` : "\u4E0A\u4E0B\u6587\u63D0\u9192\uFF1A\u5173"
      );
      lines.push(rhythm.handoffReminder ? "\u4EA4\u63A5\u540E\u63D0\u9192\u8865\u5199\uFF1A\u5F00" : "\u4EA4\u63A5\u540E\u63D0\u9192\u8865\u5199\uFF1A\u5173");
      const m = rhythm.maintenance;
      if (!m.enabled) lines.push("\u81EA\u52A8\u5F52\u6863\uFF1A\u5173");
      else {
        const parts = [`${m.ageDays} \u5929\u6CA1\u53D6\u7528\u4E14\u91CD\u8981\u5EA6 \u2264 ${m.importance}`];
        if (m.conflicts) parts.push(`\u5185\u5BB9\u91CD\u590D\u5EA6 \u2265 ${Math.round(m.similarity * 100)}% \u7684\u65E7\u6761\u76EE`);
        parts.push("\u7F6E\u9876\u4E0E\u91CD\u8981\u5EA6 5 \u4E0D\u81EA\u52A8\u52A8");
        const tail = m.lastRunAt ? `\uFF5C\u4E0A\u6B21 ${when(m.lastRunAt)} \u5F52\u6863 ${m.lastArchived} \u6761\uFF08\u7D2F\u8BA1 ${m.totalArchived}\uFF09` : "\uFF5C\u8FD8\u6CA1\u8DD1\u8FC7";
        lines.push(`\u81EA\u52A8\u5F52\u6863\uFF1A${parts.join("\uFF1B")}${tail}`);
      }
      if (rhythm.lastReminder) {
        const kind2 = rhythm.lastReminder.kind === "schedule" ? "\u5B9A\u65F6" : rhythm.lastReminder.kind === "context" ? "\u4E0A\u4E0B\u6587" : "\u4EA4\u63A5";
        lines.push(`\u6700\u8FD1\u4E00\u6B21\u63D0\u9192\uFF1A${when(rhythm.lastReminder.at)}\uFF08${kind2}\uFF09`);
      }
      if (m.sample.length) lines.push(`\u4E0A\u6B21\u81EA\u52A8\u5F52\u6863\uFF1A${m.sample.map((item) => item.reason).join("\uFF1B")}`);
      rhythmBody.replaceChildren(...lines.map((line) => ui.h("div", "muted", line)));
      rhythmBody.style.cssText = "font-size:12px;line-height:1.7;";
    };
    const renderSnapshot = (snapshot) => {
      renderRhythm(snapshot.rhythm);
      stats.replaceChildren(
        ui.stat({ k: "\u672A\u5F52\u6863", v: snapshot.counts.live, unit: "\u6761", accent: true }),
        ui.stat({ k: "\u5F52\u6863", v: snapshot.counts.archived, unit: "\u6761" }),
        ui.stat({ k: "\u7F6E\u9876", v: snapshot.counts.pinned, unit: "\u6761" }),
        ui.stat({ k: "\u5BB9\u91CF\u4E0A\u9650", v: snapshot.limit, unit: "\u6761" })
      );
      embedLine.textContent = snapshot.embed.enabled ? `\u8BED\u4E49\u68C0\u7D22\uFF1A${snapshot.embed.state === "ready" ? "\u5C31\u7EEA" : snapshot.embed.state === "partial" ? `\u90E8\u5206\u5C31\u7EEA\uFF08${snapshot.embed.indexed}/${snapshot.embed.live} \u6761\u6709\u5411\u91CF\uFF09` : snapshot.embed.state === "error" ? `\u51FA\u9519\uFF08${snapshot.embed.lastError ?? "\u672A\u77E5"}\uFF09` : "\u5F00\u4E86\u4F46\u6CA1\u914D\u597D"} \xB7 ${snapshot.embed.model}` : "\u8BED\u4E49\u68C0\u7D22\uFF1A\u5173\uFF08\u53EA\u7528\u5B57\u9762\u5339\u914D\uFF09\u3002\u5230\u300C\u5D4C\u5165\u300D\u9875\u7B7E\u53EF\u4EE5\u63A5\u4E0A\u672C\u5730\u6216\u4E91\u7AEF\u7684\u5D4C\u5165\u6A21\u578B\u3002";
      embedLine.classList.toggle("bad", snapshot.embed.state === "error");
      const kinds = snapshot.kinds.map((item) => `${item.label} ${item.count}`).join(" \xB7 ");
      const tags = snapshot.tags.length ? snapshot.tags.map((item) => `${item.tag}(${item.count})`).join("\u3001") : "\uFF08\u8FD8\u6CA1\u6709\u6807\u7B7E\uFF09";
      note.textContent = `\u79CD\u7C7B\uFF1A${kinds}\uFF5C\u6807\u7B7E\uFF1A${tags}\uFF5C\u5B58\u6863\uFF1A${snapshot.storeFile}`;
      renderRows(snapshot.recent);
      if (snapshot.recent.length) {
        msg.textContent = `\u6700\u8FD1\u4FEE\u8BA2\u7684 ${snapshot.recent.length} \u6761\u3002`;
        msg.classList.remove("bad");
      } else {
        msg.textContent = "\u8BB0\u5FC6\u5E93\u8FD8\u662F\u7A7A\u7684\uFF1A\u8BA9\u6A21\u578B\u7528 ink_remember \u5199\u7B2C\u4E00\u6761\u3002";
      }
    };
    const load = async (recent = false) => {
      const busy = ui.busy("\u8BFB\u53D6\u8BB0\u5FC6\u5E93");
      try {
        const result = await ctx.invoke("snapshot");
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? "\u8BFB\u53D6\u5931\u8D25";
          msg.classList.add("bad");
          table.clear("\u8BFB\u53D6\u5931\u8D25\u3002");
          return;
        }
        renderSnapshot(result.data);
        if (recent) {
          query.value = "";
          tag.value = "";
          kind.value = "";
          archived.setChecked(false);
        }
      } catch (error) {
        msg.textContent = textOf2(error);
        msg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const run = async () => {
      if (!query.value.trim() && !tag.value.trim() && !kind.value && !archived.checked) {
        ui.toast("\u7ED9\u4E00\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u52FE\u300C\u542B\u5F52\u6863\u300D\u770B\u5168\u90E8", "bad");
        return;
      }
      const busy = ui.busy("\u68C0\u7D22\u4E2D");
      msg.textContent = "\u68C0\u7D22\u4E2D\u2026";
      msg.classList.remove("bad");
      try {
        const result = await ctx.invoke("search", [
          {
            query: query.value,
            tag: tag.value,
            kind: kind.value,
            includeArchived: archived.checked,
            limit: 30
          }
        ]);
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? "\u68C0\u7D22\u5931\u8D25";
          msg.classList.add("bad");
          table.clear("\u68C0\u7D22\u5931\u8D25\u3002");
          return;
        }
        const data = result.data;
        renderRows(data.hits);
        if (!data.hits.length) {
          msg.textContent = data.hint ?? (data.degraded ? `\u6CA1\u6709\u547D\u4E2D\uFF1B\u8BED\u4E49\u68C0\u7D22\u8FD9\u6B21\u6CA1\u8FDE\u4E0A\uFF08${data.degraded}\uFF09` : "\u6CA1\u6709\u547D\u4E2D\u3002");
          return;
        }
        msg.textContent = `${data.hits.length} \u6761${data.semantic ? "\uFF08\u542B\u8BED\u4E49\uFF09" : ""}\uFF5C${data.plan}${data.degraded ? `\uFF5C\u8BED\u4E49\u672A\u8FDE\u4E0A\uFF1A${data.degraded}` : ""}`;
        if (data.degraded) msg.classList.add("bad");
      } catch (error) {
        msg.textContent = textOf2(error);
        msg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    await load();
  }
};
var library_default = panel2;

// src/webui/client.ts
var bundle = {
  panels: { library: library_default, embedding: embedding_default }
};
var client_default = bundle;
export {
  client_default as default
};
