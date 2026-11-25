# 给接手这个包的人 / 模型

- `cortico.api` 是 6（world 契约版本）。宿主升契约时先跑 `pnpm check:extension <本包目录>` 看它打印的版本。
- 改了工具、事件或 `src/ENV_PROMPT.md`，要重跑 `pnpm describe:extension <本包目录>`，否则 `describe.json` 与代码不一致（check 会报）。本机没有 pnpm 时用 `node _dev/gen-describe.mjs` 重生成。
- World id 固定 `thepalestink`（全小写、无连字符：WebUI 页 id 是 `world:thepalestink`，协议只接受小写字母数字与 `-`；事件 type 段内也不许连字符）。工具前缀固定 `ink_`，配置路径因此是 `worlds.thepalestink.*`。
- 七个工具：`ink_remember` / `ink_search` / `ink_recall` / `ink_amend` / `ink_forget` / `ink_list` / `ink_stats`。面板两个页签：`library`（记忆库，只读）与 `embedding`（嵌入配置）。
- 数据两份：`<dataDir>/thepalestink/entries.json`（`MEMORY_SCHEMA = 1`，删它等于清空记忆库）与 `<dataDir>/thepalestink/vectors.json`（`VECTOR_SCHEMA = 1`，删它只丢向量、不丢正文）。schema 升级要写迁移，不要静默丢弃旧字段。
- 写盘都是 `.tmp` + rename；坏档改名成 `*.broken-<时间戳>` 后空库继续，`store.recovery()` / `vectors.recovery()` 记着备份路径。
- 容量策略在 `MemoryStore.add()` → `enforceLimit()`：只数**未归档**条目，超限按 `lastRecalledAt ?? updatedAt` 最旧优先淘汰到归档（`archived: true` + `archiveReason`），`pinned` 不淘汰。`_dev/verify.mjs` 里有置顶保护与热改上限的用例，改策略先跑它。
- 归档区只留最近 `ARCHIVE_KEEP = 200` 条（`trimArchived()`，置顶的除外）。
- 字面检索在 `src/search.ts` 是纯函数：`tokenize()` 用 `\p{L}\p{N}` 切词、去重、丢弃单拉丁字符、最多 8 个；拉丁词是 **AND**；中文按 2-gram（最多 12 个）算覆盖，覆盖 < 0.5 判不命中；打分 = 正文出现次数（最多 3 次）×3 + 标签精确 5 / 含 2 + 来源 1，再叠加 `importance*0.5 + pinned 1 + 90 天内线性 recency`。
- 语义检索也在这一个函数里：`SearchOptions.semantic = {queryVector, weight, minCosine?, vectorFor}`，余弦 ≥ `DEFAULT_MIN_COSINE = 0.35` 才计 `weight*10*cos`；字面与语义都没有就丢弃。**没有字面命中、只有语义命中是允许的**——但别把 0.35 调到很低，「勉强相关」比「没找到」更难发现。
- `MemoryStore` / `VectorStore` / `EmbeddingClient` 都不 import 宿主，`src/world.ts` 才 import `cortico/world.ts` 的类型。`_dev/verify.mjs` 靠这个分层用 Node 类型擦除直跑。
- 嵌入三件套：`src/embedding.ts`（HTTP + 限流 + 重试，`fetchImpl`/`sleep`/`now`/`budget` 都可注入，测试不联网）、`src/vector.ts`（向量仓 + 每日用量账本）、`src/search.ts`（排序）。改限流先看 `embedding.ts` 的 `acquire()`：并发信号量 + `60000/rpm` 槽位，槽位是「排队」不是「丢弃」。
- 限流参数的底线：`concurrency` 1–8、`requestsPerMinute` 6–6000、`maxRetries` 0–5、`dailyBudget` 0–100000、`timeoutMs` 1000–120000。`budget` 到顶必须**不发请求**直接抛 `EmbeddingError('budget')`；429 必须尊重 `Retry-After`。
- 密钥只走 `ctx.storeSecret(name, value)` 写进部署 `.env`；配置里 `embedApiKeySecret` 只存**变量名**。别把密钥写进 `entries.json`、`vectors.json` 或日志。
- 嵌入失败一律**降级**：`noteEmbedFailure()` 记下原因，检索退回字面并在回执里说明「语义检索这次没连上」。不要因为嵌入挂了就让 `ink_remember` / `ink_search` 失败。
- 换模型 / 换地址 / 改维度时 `vectors.reset()` 整仓作废——向量跟模型绑定，混用等于乱排序。`backfill()` 只补缺的，单次上限 200 条（启动时），面板「重建向量」才不限量。
- `ink_forget` 默认只归档；`purge: true` 必须 `worlds.thepalestink.hardDeleteOnForget === true` 才接受，否则回失败回执（`{ failed: true }`）。这是有意的双闸，别为了顺手拆掉。
- 配置全部 `x-hot`：`syncConfig()` 在每次工具调用前跑，`maxEntries` 改小会**立刻**淘汰并推 `ink.memory.evicted`。
- 环境提示词在 `src/ENV_PROMPT.md`，占位符 `{{thepalestink.count}}` / `{{thepalestink.archived}}` / `{{thepalestink.maxEntries}}` / `{{thepalestink.topTags}}` / `{{thepalestink.semantic}}` 由 `envPromptVars()` 提供。改占位符名要两边一起改。
- 面板：服务端在 `src/world.ts` 的 `invoke()`（`library` / `embedding` 各一个 switch），客户端在 `src/webui/panels/*.ts`，打包入口 `src/webui/client.ts` → `dist/webui.js`（manifest 的 `cortico.webUiClient`）。客户端只能 `import type`，不能 import 服务端模块；面板返回统一 `{ok,data}|{ok:false,error}`，别抛异常穿透。
- 面板加方法要改两处：`invoke()` 的 switch 与 `panels` 声明里的 `getMethods`（省略 `getMethods` 就只接受 POST）。
- 改完面板必须 `pnpm build:webui`（或 `node node_modules/esbuild/bin/esbuild src/webui/client.ts --bundle --format=esm --target=es2022 --platform=browser --outfile=dist/webui.js`），否则页面加载的是旧 bundle。
- 文案口径：模型对**人类**称「对方」，模型自己称「你」；回执不是正文，不要整段贴回。

## 验证到哪一级

- 行为自检：`node _dev/verify.mjs` → **69 项全过**（落盘、坏档、容量、字面/语义检索、向量仓、嵌入分批与预算、七工具、事件、面板、热改）。不依赖 pnpm，改 store/search/vector/embedding/world 后先跑它。
- 类型检查：`tsc --noEmit`（主项目）与 `tsc -p tsconfig.webui.json --noEmit`（面板）**都通过，0 错误**。
- 单元测试：`vitest run` → **43/43 通过**（`tests/world.test.ts` 13、`tests/search.test.ts` 13、`tests/embedding.test.ts` 11、`tests/vector.test.ts` 6）。
- 面板构建：`dist/webui.js` **26649 B**，esbuild 无警告。
- **注意 `pnpm` 在这台机器上会静默挂住**（装好了 12.23.0，但 `pnpm install` / `pnpm typecheck` 都无输出卡死，原因未查）。当前可用的替身：`npm install --ignore-scripts` 装依赖，然后 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run`。
- `describe:extension` / `check:extension`：**已用宿主源码跑完第②级**——`node node_modules/tsx/dist/cli.mjs _dev/host-check.ts` 直接调宿主的 `dryMountWorld()` 与 `checkDescribe()`：7 个工具、5 个占位符、2 个面板、1 个配置组全部通过，`describe.json` 与代码里的自描述逐字段一致。`check:extension` 本体没跑（它要宿主的依赖，本机没装）。
- `defaults().enabled` 恒为 `false`：宿主 `dryMount` 会拿这条当警告，装不装、开不开由 bot 声明与部署决定。
- 第三级（装进实例目击行为）：未做，待开发者。要看的现象：World 页多两个页签、`ink_search` 回执、嵌入页「测试连接」出维度与耗时。

## 提交前

```bash
pnpm typecheck && pnpm test && pnpm build:webui
```

发布前再跑 `describe:extension` 与 `check:extension`，确认 `describe.json` 与代码同步。
