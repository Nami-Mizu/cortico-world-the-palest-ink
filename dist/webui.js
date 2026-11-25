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
      head: ["\u7F16\u53F7", "\u6458\u8981", "\u79CD\u7C7B", "\u60C5\u7EEA", "\u91CD\u8981\u5EA6", "\u6700\u8FD1\u4FEE\u8BA2", ""],
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
          { k: "\u60C5\u7EEA", v: entry.entry.moodLabel },
          { k: "\u91CD\u8981\u5EA6", v: entry.entry.importance },
          { k: "\u6807\u7B7E", v: entry.entry.tags.length ? `#${entry.entry.tags.join(" #")}` : "\uFF08\u65E0\uFF09" },
          { k: "\u6765\u6E90", v: entry.source || "\uFF08\u672A\u5199\uFF09" },
          { k: "\u5199\u5165", v: when(entry.entry.createdAt) },
          { k: "\u4FEE\u8BA2", v: when(entry.entry.updatedAt) },
          { k: "\u53D6\u7528", v: `${entry.entry.recallCount} \u6B21${entry.lastRecalledAt ? `\uFF08\u6700\u8FD1 ${when(entry.lastRecalledAt)}\uFF09` : ""}` },
          {
            k: "\u6709\u6548\u671F",
            v: entry.entry.expiresAt ? `${entry.entry.ttlDays} \u5929\uFF0C${when(entry.entry.expiresAt)} \u5230\u671F${entry.entry.expired ? "\uFF08\u5DF2\u8FC7\u671F\uFF0C\u5F85\u6574\u7406\uFF09" : ""}` : "\u6C38\u4E45"
          },
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
        const flags = [hit.pinned ? "\u7F6E\u9876" : "", hit.archived ? "\u5F52\u6863" : "", hit.expired ? "\u5DF2\u8FC7\u671F" : "", hit.semantic ? "\u2248" : ""].filter(Boolean).join(" ");
        const row = table.addRow([
          hit.id.slice(0, 14),
          hit.text || hit.tags.map((item) => `#${item}`).join(" "),
          hit.kindLabel,
          hit.moodLabel,
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
        ui.stat({ k: "\u8FC7\u671F\u5F85\u6574\u7406", v: snapshot.expired.count, unit: "\u6761" }),
        ui.stat({ k: "\u5BB9\u91CF\u4E0A\u9650", v: snapshot.limit, unit: "\u6761" })
      );
      embedLine.textContent = snapshot.embed.enabled ? `\u8BED\u4E49\u68C0\u7D22\uFF1A${snapshot.embed.state === "ready" ? "\u5C31\u7EEA" : snapshot.embed.state === "partial" ? `\u90E8\u5206\u5C31\u7EEA\uFF08${snapshot.embed.indexed}/${snapshot.embed.live} \u6761\u6709\u5411\u91CF\uFF09` : snapshot.embed.state === "error" ? `\u51FA\u9519\uFF08${snapshot.embed.lastError ?? "\u672A\u77E5"}\uFF09` : "\u5F00\u4E86\u4F46\u6CA1\u914D\u597D"} \xB7 ${snapshot.embed.model}` : "\u8BED\u4E49\u68C0\u7D22\uFF1A\u5173\uFF08\u53EA\u7528\u5B57\u9762\u5339\u914D\uFF09\u3002\u5230\u300C\u5D4C\u5165\u300D\u9875\u7B7E\u53EF\u4EE5\u63A5\u4E0A\u672C\u5730\u6216\u4E91\u7AEF\u7684\u5D4C\u5165\u6A21\u578B\u3002";
      embedLine.classList.toggle("bad", snapshot.embed.state === "error");
      const kinds = snapshot.kinds.map((item) => `${item.label} ${item.count}`).join(" \xB7 ");
      const moods = snapshot.moods.length ? snapshot.moods.map((item) => `${item.label} ${item.count}`).join(" \xB7 ") : "\uFF08\u8FD8\u6CA1\u6807\u8FC7\uFF09";
      const tags = snapshot.tags.length ? snapshot.tags.map((item) => `${item.tag}(${item.count})`).join("\u3001") : "\uFF08\u8FD8\u6CA1\u6709\u6807\u7B7E\uFF09";
      note.textContent = `\u79CD\u7C7B\uFF1A${kinds}\uFF5C\u60C5\u7EEA\uFF1A${moods}\uFF5C\u6807\u7B7E\uFF1A${tags}\uFF5C\u8FC7\u671F\u5F85\u6574\u7406 ${snapshot.expired.count} \u6761\uFF5C\u5B58\u6863\uFF1A${snapshot.storeFile}`;
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

// src/webui/starmap-layout.ts
var MAX_ANCHORS = 8;
var MAX_LAYOUT_POINTS = 800;
var MARGIN = 24;
var RELAX_ITERATIONS = 48;
var GOLDEN = 2654435769;
function hash32(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function noise(seed, salt) {
  const mixed = (seed ^ Math.imul(salt + GOLDEN, 2246822507)) >>> 0;
  return ((mixed ^ mixed >>> 15) >>> 0) / 4294967295;
}
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function nodeRadius(point) {
  const importance = Number.isFinite(point.importance) ? clamp(point.importance, 0, 5) : 0;
  return 3.6 + importance * 1.25 + (point.pinned ? 1.1 : 0);
}
function findNode(nodes, x, y, slack = 8) {
  let best = null;
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
function layoutStarMap(points, tagCounts, width, height) {
  const w = Math.max(320, Math.round(width));
  const h = Math.max(240, Math.round(height));
  const centerX = w / 2;
  const centerY = h / 2;
  const ring = Math.min(w, h) * 0.33;
  const maxRadius = Math.min(w, h) / 2 - MARGIN;
  const ranked = tagCounts.filter((item) => item.count > 0 && item.tag).slice().sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag)).slice(0, MAX_ANCHORS);
  const anchors = ranked.map((item, index) => {
    const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(1, ranked.length);
    return {
      tag: item.tag,
      count: item.count,
      x: centerX + Math.cos(angle) * ring,
      y: centerY + Math.sin(angle) * ring,
      radius: Math.min(maxRadius, 26 + 5 * Math.sqrt(item.count))
    };
  });
  const anchorByTag = /* @__PURE__ */ new Map();
  for (const anchor of anchors) anchorByTag.set(anchor.tag, anchor);
  const membersOf = (point) => {
    const found = [];
    for (const tag of point.tags) {
      const anchor = anchorByTag.get(tag);
      if (anchor) found.push(anchor);
    }
    return found;
  };
  const kept = points.slice(0, MAX_LAYOUT_POINTS);
  const clusterSize = /* @__PURE__ */ new Map();
  for (const point of kept) {
    const members = membersOf(point);
    if (!members.length) continue;
    const tag = members[0]?.tag;
    if (tag) clusterSize.set(tag, (clusterSize.get(tag) ?? 0) + 1);
  }
  const working = kept.map((point) => {
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
      const firstTag = members[0]?.tag ?? "";
      spread = 8 + 6 * Math.sqrt(clusterSize.get(firstTag) ?? 1);
    } else {
      const angle2 = noise(seed, 1) * Math.PI * 2;
      const radius = 34 + noise(seed, 2) * ring * 0.52;
      targetX = centerX + Math.cos(angle2) * radius;
      targetY = centerY + Math.sin(angle2) * radius;
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
      radius: nodeRadius(point)
    };
  });
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
      y: clamp(anchor.y, MARGIN, h - MARGIN)
    })),
    nodes: working.map((item) => ({ id: item.id, x: item.x, y: item.y, radius: item.radius }))
  };
}

// src/webui/panels/starmap.ts
var KIND_OPTIONS2 = [
  { value: "", label: "\u5168\u90E8\u79CD\u7C7B" },
  { value: "fact", label: "\u4E8B\u5B9E" },
  { value: "event", label: "\u4E8B\u4EF6" },
  { value: "preference", label: "\u504F\u597D" },
  { value: "todo", label: "\u5F85\u529E" },
  { value: "note", label: "\u6742\u8BB0" }
];
var KIND_COLORS = {
  fact: "#6fa8ff",
  event: "#ffb86b",
  preference: "#ff8fd0",
  todo: "#7fe0a0",
  note: "#b9a7ff"
};
var KIND_LABELS = {
  fact: "\u4E8B\u5B9E",
  event: "\u4E8B\u4EF6",
  preference: "\u504F\u597D",
  todo: "\u5F85\u529E",
  note: "\u6742\u8BB0"
};
var MAP_HEIGHT = 520;
function when2(iso) {
  if (!iso) return "\u2014";
  return iso.slice(0, 16).replace("T", " ");
}
function textOf3(error) {
  return error instanceof Error ? error.message : String(error);
}
var panel3 = {
  async mount(ctx) {
    const ui = ctx.ui;
    const sheet = ui.sheet({
      title: "\u661F\u56FE",
      en: "Star map",
      desc: "\u6BCF\u6761\u8BB0\u5FC6\u4E00\u4E2A\u70B9\uFF1B\u5706\u5708\u662F\u6807\u7B7E\u7684\u5F15\u529B\u8303\u56F4\u3002\u70B9\u7684\u5927\u5C0F\u662F\u91CD\u8981\u5EA6\uFF0C\u5B9E\u5FC3\u773C\u662F\u7F6E\u9876\uFF0C\u865A\u7EBF\u5708\u662F\u5DF2\u8FC7\u671F\u3002\u53EA\u8BFB\u89C6\u56FE\u3002"
    });
    ctx.root.append(sheet.el);
    const bar = ui.rowbar();
    const kind = ui.select({ options: KIND_OPTIONS2 });
    const tag = ui.input({ placeholder: "\u53EA\u770B\u67D0\u4E2A\u6807\u7B7E\uFF08\u53EF\u9009\uFF09" });
    const archived = ui.checkbox("\u542B\u5F52\u6863");
    const reload = ui.button("\u5237\u65B0", { variant: "primary", onClick: () => void load() });
    const resetView = ui.button("\u590D\u4F4D", { size: "sm", onClick: () => reset() });
    const zoomIn = ui.button("\uFF0B", { size: "sm", onClick: () => zoomAt(1.25) });
    const zoomOut = ui.button("\uFF0D", { size: "sm", onClick: () => zoomAt(0.8) });
    bar.append(kind, tag, archived.el, reload, resetView, zoomIn, zoomOut);
    sheet.body.append(bar);
    const msg = ui.msgline();
    sheet.body.append(msg);
    const wrap = ui.h("div");
    wrap.style.cssText = "position:relative;margin:8px 0;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `display:block;width:100%;height:${MAP_HEIGHT}px;border-radius:10px;touch-action:none;cursor:grab;background:rgba(127,127,127,.06);`;
    const tip = ui.h("div");
    tip.style.cssText = "position:absolute;pointer-events:none;max-width:280px;padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.5;background:rgba(20,20,24,.92);color:#eee;box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;z-index:2;white-space:pre-wrap;";
    wrap.append(canvas, tip);
    sheet.body.append(wrap);
    const legend = ui.h("div", "muted");
    legend.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;margin:4px 0 10px;";
    for (const [name, label] of Object.entries(KIND_LABELS)) {
      const item = ui.h("span");
      const dot = ui.h("span");
      dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:${KIND_COLORS[name] ?? "#888"};`;
      item.append(dot, document.createTextNode(label));
      legend.append(item);
    }
    const notes = ui.h("span", "muted", "\u5927\u5C0F = \u91CD\u8981\u5EA6\uFF5C\u5B9E\u5FC3\u773C = \u7F6E\u9876\uFF5C\u865A\u7EBF\u5708 = \u5DF2\u8FC7\u671F\uFF5C\u7070 = \u5F52\u6863");
    legend.append(notes);
    sheet.body.append(legend);
    const detail = ui.h("div");
    sheet.body.append(detail);
    const state = {
      response: null,
      layout: null,
      byId: /* @__PURE__ */ new Map(),
      hover: null,
      selected: null
    };
    const view = { scale: 1, x: 0, y: 0 };
    const canvas2d = () => canvas.getContext("2d");
    const cssWidth = () => Math.max(320, Math.round(canvas.clientWidth || wrap.clientWidth || 800));
    const reset = () => {
      view.scale = 1;
      view.x = 0;
      view.y = 0;
      draw();
    };
    const zoomAt = (factor) => {
      const next = Math.min(3, Math.max(0.6, view.scale * factor));
      const ratio = next / view.scale;
      view.x *= ratio;
      view.y *= ratio;
      view.scale = next;
      draw();
    };
    const toWorld = (screenX, screenY) => {
      const width = cssWidth();
      return {
        x: (screenX - width / 2 - view.x) / view.scale + width / 2,
        y: (screenY - MAP_HEIGHT / 2 - view.y) / view.scale + MAP_HEIGHT / 2
      };
    };
    const draw = () => {
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
      const fg = getComputedStyle(canvas).color || "#ccc";
      context.save();
      context.translate(width / 2 + view.x, MAP_HEIGHT / 2 + view.y);
      context.scale(view.scale, view.scale);
      context.translate(-width / 2, -MAP_HEIGHT / 2);
      context.lineWidth = 1;
      context.font = "11px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
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
        const base = KIND_COLORS[point.kind] ?? "#9aa3b2";
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
          context.strokeStyle = "#ffb86b";
          context.lineWidth = 1.2;
          context.setLineDash([2.5, 2]);
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 4.2, 0, Math.PI * 2);
          context.stroke();
          context.setLineDash([]);
        }
        if (selected) {
          context.globalAlpha = 1;
          context.strokeStyle = "#ffffff";
          context.lineWidth = 1.6;
          context.beginPath();
          context.arc(node.x, node.y, node.radius + 6.5, 0, Math.PI * 2);
          context.stroke();
        }
        if (hovered) {
          context.globalAlpha = 0.55;
          context.strokeStyle = "#ffffff";
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
    const showTip = (node, screenX, screenY) => {
      const point = state.byId.get(node.id);
      if (!point) return;
      const flags = [point.pinned ? "\u7F6E\u9876" : "", point.expired ? "\u5DF2\u8FC7\u671F" : "", point.archived ? "\u5DF2\u5F52\u6863" : ""].filter(Boolean).join(" \xB7 ");
      const tags = point.tags.length ? `#${point.tags.join(" #")}` : "\uFF08\u6CA1\u6709\u6807\u7B7E\uFF09";
      tip.textContent = `${point.text || "\uFF08\u53EA\u6709\u6807\u7B7E\uFF09"}
${point.kind ? KIND_LABELS[point.kind] ?? point.kind : ""}${flags ? ` \xB7 ${flags}` : ""}
${tags}
\u4FEE\u8BA2 ${when2(point.updatedAt)} \xB7 \u53D6\u7528 ${point.recallCount} \u6B21`;
      tip.style.display = "block";
      const left = Math.min(screenX + 14, cssWidth() - 296);
      const top = Math.max(6, Math.min(screenY - 10, MAP_HEIGHT - 90));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
    const hideTip = () => {
      tip.style.display = "none";
    };
    const showDetail = async (id) => {
      const busy = ui.busy("\u8BFB\u53D6\u6761\u76EE", id);
      try {
        const result = await ctx.invoke("entry", [{ id }]);
        if (!result.ok || !result.data) {
          ui.toast(result.error ?? "\u8BFB\u53D6\u5931\u8D25", "bad");
          return;
        }
        const data = result.data;
        const card = ui.h("div");
        card.style.cssText = "margin-top:10px;padding:12px;border:1px solid rgba(128,128,128,.25);border-radius:10px;";
        const head = ui.h("div");
        head.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;";
        head.append(
          ui.pill(data.entry.kindLabel, "off"),
          ui.pill(`\u91CD\u8981\u5EA6 ${data.entry.importance}`, "off"),
          ...data.entry.pinned ? [ui.pill("\u7F6E\u9876", "on")] : [],
          ...data.entry.expired ? [ui.pill("\u5DF2\u8FC7\u671F", "plain")] : [],
          ...data.entry.archived ? [ui.pill(`\u5DF2\u5F52\u6863\uFF1A${data.archiveReason ?? "\u672A\u5199\u539F\u56E0"}`, "off")] : []
        );
        const meta = ui.kv([
          { k: "\u7F16\u53F7", v: data.entry.id },
          { k: "\u6807\u7B7E", v: data.entry.tags.length ? `#${data.entry.tags.join(" #")}` : "\uFF08\u65E0\uFF09" },
          { k: "\u6765\u6E90", v: data.source || "\uFF08\u672A\u5199\uFF09" },
          { k: "\u4FEE\u8BA2", v: when2(data.entry.updatedAt) },
          { k: "\u53D6\u7528", v: `${data.entry.recallCount} \u6B21${data.lastRecalledAt ? `\uFF08\u6700\u8FD1 ${when2(data.lastRecalledAt)}\uFF09` : ""}` },
          {
            k: "\u6709\u6548\u671F",
            v: data.entry.expiresAt ? `${data.entry.ttlDays} \u5929\uFF0C${when2(data.entry.expiresAt)} \u5230\u671F` : "\u6C38\u4E45"
          }
        ]);
        const text = ui.h("pre", "mono", data.text);
        text.style.cssText = "white-space:pre-wrap;margin:10px 0;max-height:240px;overflow:auto;";
        const actions = ui.actions();
        actions.append(
          ui.copyButton(data.text, { label: "\u590D\u5236\u6B63\u6587" }),
          ui.button("\u5173\u95ED", { size: "sm", onClick: () => card.remove() })
        );
        card.append(head, meta, text, actions);
        detail.replaceChildren(card);
      } catch (error) {
        ui.toast(textOf3(error), "bad");
      } finally {
        busy.dispose();
      }
    };
    const load = async () => {
      const busy = ui.busy("\u8BFB\u53D6\u661F\u56FE");
      msg.classList.remove("bad");
      msg.textContent = "\u8BFB\u53D6\u4E2D\u2026";
      try {
        const result = await ctx.invoke("map", [
          {
            kind: kind.value,
            tag: tag.value.trim(),
            includeArchived: archived.checked
          }
        ]);
        if (!result.ok || !result.data) {
          msg.textContent = result.error ?? "\u8BFB\u53D6\u5931\u8D25";
          msg.classList.add("bad");
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
        msg.textContent = textOf3(error);
        msg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const applyMessage = () => {
      const response = state.response;
      if (!response) return;
      if (!response.points.length) {
        msg.textContent = "\u8FD9\u91CC\u8FD8\u6CA1\u6709\u70B9\uFF1A\u8BA9\u6A21\u578B\u7528 ink_remember \u5199\u7B2C\u4E00\u6761\uFF0C\u6216\u53BB\u6389\u7B5B\u9009\u9879\u3002";
        return;
      }
      const parts = [`${response.counts.shown} \u4E2A\u70B9`];
      if (response.counts.archived) parts.push(`\u5176\u4E2D\u5F52\u6863 ${response.counts.archived} \u6761`);
      if (response.truncated) parts.push(`\u53E6\u6709 ${response.counts.matched - response.counts.shown} \u6761\u6CA1\u753B\uFF08\u70B9\u592A\u591A\uFF0C\u7F29\u5C0F\u8303\u56F4\u6216\u63D0\u9AD8\u5BB9\u91CF\uFF09`);
      parts.push("\u62D6\u62FD\u5E73\u79FB\uFF0C\u6EDA\u8F6E\u7F29\u653E\uFF0C\u70B9\u5706\u70B9\u770B\u8BE6\u60C5");
      msg.textContent = parts.join("\uFF5C");
    };
    const relayout = () => {
      const response = state.response;
      if (!response) return;
      const layout = layoutStarMap(response.points, response.tags, cssWidth(), MAP_HEIGHT);
      state.layout = layout;
    };
    const onResize = () => {
      relayout();
      draw();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => onResize());
    observer?.observe(wrap);
    ctx.signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;
    let moved = 0;
    canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      moved = 0;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragOriginX = view.x;
      dragOriginY = view.y;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", (event) => {
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
        canvas.style.cursor = "pointer";
        showTip(node, event.clientX - rect.left, event.clientY - rect.top);
      } else {
        canvas.style.cursor = "grab";
        hideTip();
      }
      draw();
    });
    canvas.addEventListener("pointerup", (event) => {
      dragging = false;
      canvas.style.cursor = "grab";
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
    canvas.addEventListener("pointerleave", () => {
      state.hover = null;
      hideTip();
      draw();
    });
    canvas.addEventListener(
      "wheel",
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
      { passive: false }
    );
    await load();
  }
};
var starmap_default = panel3;

// src/webui/panels/data.ts
function textOf4(error) {
  return error instanceof Error ? error.message : String(error);
}
function money(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function download(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
var panel4 = {
  async mount(ctx) {
    const ui = ctx.ui;
    const sheet = ui.sheet({
      title: "\u6570\u636E",
      en: "Import / Export",
      desc: "\u5BFC\u51FA\u4E00\u4EFD JSON \u5FEB\u7167\uFF1B\u6216\u4ECE\u5FEB\u7167\u5BFC\u5165\u3002\u5BFC\u5165\u5148\u9884\u6F14\uFF0C\u5199\u76D8\u524D\u81EA\u52A8\u5907\u4EFD\uFF0C\u4E0D\u4F1A\u6084\u6084\u8986\u76D6\u3002"
    });
    ctx.root.append(sheet.el);
    const stats = ui.statgrid();
    sheet.body.append(stats);
    const statusLine = ui.msgline();
    sheet.body.append(statusLine);
    const exportBar = ui.rowbar();
    const includeArchived = ui.checkbox("\u542B\u5F52\u6863\u6761\u76EE", { checked: true });
    const exportBtn = ui.button("\u5BFC\u51FA JSON", {
      variant: "primary",
      onClick: () => void doExport()
    });
    exportBar.append(includeArchived.el, exportBtn);
    sheet.body.append(ui.section("\u5BFC\u51FA", "\u5FEB\u7167\u542B\u6B63\u6587\u4E0E\u5143\u6570\u636E\uFF08id\u3001\u65F6\u95F4\u3001\u6807\u7B7E\u3001\u6709\u6548\u671F\uFF09\uFF1B\u4E0D\u542B\u5411\u91CF\u3002"), exportBar);
    const exportMsg = ui.msgline();
    sheet.body.append(exportMsg);
    const importSection = ui.section(
      "\u5BFC\u5165",
      "\u5408\u5E76 = \u672C\u5730\u4F18\u5148\uFF1A\u540C id\u3001\u5185\u5BB9\u51E0\u4E4E\u91CD\u590D\u7684\u90FD\u8DF3\u8FC7\uFF0C\u53EA\u8865\u65B0\u7684\u3002\u8986\u76D6 = \u8BA9\u672C\u5730\u53EA\u5269\u6587\u4EF6\u91CC\u90A3\u4E9B\uFF08\u5199\u76D8\u524D\u4E00\u5B9A\u5907\u4EFD\uFF09\u3002"
    );
    sheet.body.append(importSection);
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.cssText = "max-width:100%;";
    const mode = ui.select({
      options: [
        { value: "merge", label: "\u5408\u5E76\uFF08\u672C\u5730\u4F18\u5148\uFF09" },
        { value: "replace", label: "\u8986\u76D6\uFF08\u6E05\u7A7A\u672C\u5730\uFF09" }
      ]
    });
    const confirm = ui.input({ placeholder: "\u8986\u76D6\u5BFC\u5165\u65F6\u5728\u8FD9\u91CC\u6253\u300C\u66FF\u6362\u300D" });
    confirm.style.display = "none";
    const previewBtn = ui.button("\u9884\u6F14", {
      onClick: () => void doPreview()
    });
    const importBtn = ui.button("\u6267\u884C\u5BFC\u5165", { variant: "primary", onClick: () => void doImport() });
    importBtn.disabled = true;
    const importBar = ui.rowbar();
    importBar.append(file, mode, confirm, previewBtn, importBtn);
    importSection.append(importBar);
    const importMsg = ui.msgline();
    importSection.append(importMsg);
    const previewBox = ui.h("div");
    previewBox.style.cssText = "margin-top:10px;";
    importSection.append(previewBox);
    let payload = "";
    let previewMode = "";
    const renderStatus = (data) => {
      stats.replaceChildren(
        ui.stat({ k: "\u672A\u5F52\u6863", v: data.counts.live, unit: "\u6761", accent: true }),
        ui.stat({ k: "\u5DF2\u5F52\u6863", v: data.counts.archived, unit: "\u6761" }),
        ui.stat({ k: "\u5B58\u6863\u5927\u5C0F", v: money(data.entriesBytes) }),
        ui.stat({ k: "\u5411\u91CF", v: data.vectorCount, unit: "\u6761" })
      );
      statusLine.textContent = `\u5B58\u6863\uFF1A${data.storeFile}\uFF5C\u5411\u91CF\uFF1A${data.vectorFile}`;
      statusLine.title = statusLine.textContent;
      const bits = [];
      if (data.lastImportAt) bits.push(`\u4E0A\u6B21\u5BFC\u5165 ${data.lastImportAt.slice(0, 16).replace("T", " ")}`);
      if (data.lastBackup) bits.push(`\u5907\u4EFD ${data.lastBackup}`);
      if (data.expired) bits.push(`\u8FC7\u671F\u5F85\u6574\u7406 ${data.expired} \u6761`);
      if (bits.length) exportMsg.textContent = bits.join("\uFF5C");
    };
    const refresh = async () => {
      try {
        const result = await ctx.invoke("status", []);
        if (!result.ok || !result.data) throw new Error(result.error ?? "\u8BFB\u4E0D\u5230\u72B6\u6001\u3002");
        renderStatus(result.data);
      } catch (error) {
        statusLine.textContent = `\u8BFB\u72B6\u6001\u5931\u8D25\uFF1A${textOf4(error)}`;
        statusLine.classList.add("bad");
      }
    };
    const doExport = async () => {
      const busy = ui.busy("\u5BFC\u51FA", "\u6253\u5305\u5FEB\u7167");
      try {
        const result = await ctx.invoke("export", [
          { includeArchived: includeArchived.checked }
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? "\u5BFC\u51FA\u5931\u8D25\u3002");
        const data = result.data;
        download(data.filename, data.json);
        exportMsg.textContent = `\u5DF2\u5BFC\u51FA ${data.exported} \u6761\uFF08\u5F52\u6863 ${data.archived} \u6761\uFF0C${money(data.bytes)}\uFF09\uFF1A${data.filename}`;
        exportMsg.classList.remove("bad");
      } catch (error) {
        exportMsg.textContent = `\u5BFC\u51FA\u5931\u8D25\uFF1A${textOf4(error)}`;
        exportMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    const renderPreview = (data) => {
      previewBox.replaceChildren();
      const head = ui.h(
        "div",
        void 0,
        `\u9884\u6F14\uFF1A\u6587\u4EF6 ${data.incoming} \u6761 \u2192 \u4F1A\u5199 ${data.added} \u6761\uFF0C\u540C id \u8DF3\u8FC7 ${data.skipped} \u6761\uFF0C\u5185\u5BB9\u91CD\u590D\u8DF3\u8FC7 ${data.duplicateCount} \u6761\uFF0C\u65E0\u6548 ${data.invalid} \u6761\u3002`
      );
      head.style.marginBottom = "6px";
      previewBox.append(head);
      if (data.duplicates.length) {
        const dupTitle = ui.h("div", "muted", "\u50CF\u91CD\u590D\u7684\uFF1A");
        dupTitle.style.fontSize = "12px";
        previewBox.append(dupTitle);
        const list = ui.log({ max: 8, maxHeight: "140px", empty: "\uFF08\u6CA1\u6709\uFF09" });
        for (const item of data.duplicates) list.append(`${item.id} \u2248 ${item.of}\uFF08${item.similarity}%\uFF09`);
        previewBox.append(list.el);
      }
      if (data.samples.length) {
        const sampleTitle = ui.h("div", "muted", "\u4F1A\u5199\u8FDB\u53BB\u7684\uFF1A");
        sampleTitle.style.fontSize = "12px";
        previewBox.append(sampleTitle);
        const list = ui.log({ max: 8, maxHeight: "160px", empty: "\uFF08\u6CA1\u6709\uFF09" });
        for (const item of data.samples) list.append(`${item.id}\uFF1A${item.text}`);
        previewBox.append(list.el);
      }
    };
    const doPreview = async () => {
      const chosen = file.files?.[0];
      if (!chosen) {
        importMsg.textContent = "\u5148\u9009\u4E00\u4E2A JSON \u5FEB\u7167\u6587\u4EF6\u3002";
        importMsg.classList.add("bad");
        return;
      }
      const busy = ui.busy("\u9884\u6F14", chosen.name);
      try {
        payload = await chosen.text();
        previewMode = mode.value === "replace" ? "replace" : "merge";
        const result = await ctx.invoke("preview", [
          { json: payload, mode: previewMode }
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? "\u9884\u6F14\u5931\u8D25\u3002");
        renderPreview(result.data);
        importMsg.textContent = "\u9884\u6F14\u5B8C\u6210\uFF1B\u786E\u8BA4\u6570\u5B57\u540E\u70B9\u300C\u6267\u884C\u5BFC\u5165\u300D\u3002";
        importMsg.classList.remove("bad");
        importBtn.disabled = result.data.added === 0;
        confirm.style.display = previewMode === "replace" ? "" : "none";
      } catch (error) {
        previewBox.replaceChildren();
        importMsg.textContent = `\u9884\u6F14\u5931\u8D25\uFF1A${textOf4(error)}`;
        importMsg.classList.add("bad");
        importBtn.disabled = true;
        previewMode = "";
      } finally {
        busy.dispose();
      }
    };
    const doImport = async () => {
      if (!payload || !previewMode) {
        importMsg.textContent = "\u5148\u9884\u6F14\u4E00\u6B21\u518D\u5BFC\u5165\u3002";
        importMsg.classList.add("bad");
        return;
      }
      if (previewMode === "replace" && confirm.value.trim() !== "\u66FF\u6362") {
        importMsg.textContent = "\u8986\u76D6\u5BFC\u5165\u8981\u5728\u300C\u786E\u8BA4\u300D\u91CC\u8F93\u5165\u300C\u66FF\u6362\u300D\u4E24\u4E2A\u5B57\u3002";
        importMsg.classList.add("bad");
        confirm.focus();
        return;
      }
      const busy = ui.busy("\u5BFC\u5165", "\u5199\u76D8\u5E76\u5907\u4EFD");
      try {
        const result = await ctx.invoke("import", [
          { json: payload, mode: previewMode, confirm: confirm.value.trim() }
        ]);
        if (!result.ok || !result.data) throw new Error(result.error ?? "\u5BFC\u5165\u5931\u8D25\u3002");
        const data = result.data;
        const vectorLine = data.vectorize?.started ? `\u5DF2\u5F00\u59CB\u8865\u5411\u91CF\uFF1A${data.vectorize.pending} \u6761\u5F85\u5EFA\uFF0C\u5B8C\u6210\u540E\u300C\u5D4C\u5165\u300D\u9875\u7684\u5DF2\u5EFA\u5411\u91CF\u4F1A\u66F4\u65B0\u3002` : data.vectorize?.reason ? `\u5411\u91CF\uFF1A${data.vectorize.reason}` : "";
        importMsg.textContent = data.note ? data.note : `\u5DF2\u5BFC\u5165 ${data.imported} \u6761\uFF08\u8DF3\u8FC7 ${data.skipped}\uFF0C\u91CD\u590D ${data.duplicateCount}\uFF0C\u65E0\u6548 ${data.invalid}\uFF09\u3002${data.backup ? `\u5907\u4EFD\uFF1A${data.backup}` : ""}${vectorLine ? ` ${vectorLine}` : ""}`;
        importMsg.classList.remove("bad");
        previewBox.replaceChildren();
        importBtn.disabled = true;
        payload = "";
        previewMode = "";
        file.value = "";
        confirm.value = "";
        await refresh();
      } catch (error) {
        importMsg.textContent = `\u5BFC\u5165\u5931\u8D25\uFF1A${textOf4(error)}`;
        importMsg.classList.add("bad");
      } finally {
        busy.dispose();
      }
    };
    mode.addEventListener("change", () => {
      confirm.style.display = mode.value === "replace" ? "" : "none";
      importBtn.disabled = true;
      previewMode = "";
    });
    await refresh();
  }
};
var data_default = panel4;

// src/webui/client.ts
var bundle = {
  panels: { library: library_default, starmap: starmap_default, embedding: embedding_default, data: data_default }
};
var client_default = bundle;
export {
  client_default as default
};
