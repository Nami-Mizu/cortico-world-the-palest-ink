# 淡墨 · The Palest Ink

一句中文说明：一座能写、能查、能改的长期记忆库——把「以后还会用到的事」记下来，下次对话还在。

> 名字取自一句谚语：*The palest ink is better than the best memory.*（最淡的墨水，胜过最好的记性。）

## 它做什么

- 模型可以把事实、事件、偏好、待办写进记忆库，条目带标签、来源、重要度、置顶。
- 按关键词与标签检索（拉丁词是「都要命中」，中文按 2-gram 放宽），命中只回摘要行，需要全文再按 id 取用。
- 语义检索可选：接一个嵌入模型（OpenAI 兼容接口，或本地的 Ollama / LM Studio）后，「意思近」的条目也能找回来；没配就纯字面匹配，照常可用。
- 嵌入调用带限流：并发、每分钟请求数、超时、重试退避、每日预算，防止把 API 打到 429、也防止账单失控。
- 记错了可以按 id 修订；用不着了先归档、必要时才物理删除。
- 容量有上限（默认 500 条），满了淘汰**最久没被取用**的条目到归档区，置顶条目不淘汰。
- 两个面板：「记忆库」给人看条目与检索结果；「嵌入」引导人类配置供应商、测连接、看用量。
- 存档是人类可读的 JSON，坏档会先改名备份再从空库继续，不会静默丢数据。

## 装

1. 把包目录（或发布的 npm 包）装进 Cortico 的扩展目录。
2. 重启宿主。
3. 到 World 页启用「淡墨」。
4. 再重启一次，让 World 的工具与环境提示词生效。

启用直达：`world:thepalestink`（World 总览里的一张卡，卡片上有「记忆库」「嵌入」两个页签）。

## 工具

| 工具 | 标签 | 用途 |
| --- | --- | --- |
| `ink_remember` | write | 写一条记忆，返回 id |
| `ink_search` | read | 按关键词/标签/种类检索，回摘要行；开语义时同时算向量分 |
| `ink_recall` | read | 按 id 读全文，并记一次取用 |
| `ink_amend` | write | 按 id 修订正文、标签、种类、来源、重要度、置顶 |
| `ink_forget` | write | 归档一条记忆；配置允许时可物理删除 |
| `ink_list` | read, snapshot | 按最近修订倒序列出 |
| `ink_stats` | read, snapshot | 规模、种类分布、标签榜、被取用最多、语义索引状态、存档路径 |

## 面板

| 页签 | 方法 | 说明 |
| --- | --- | --- |
| 记忆库 | `snapshot` | 规模、种类分布、标签榜、最近 30 条、语义状态 |
| 记忆库 | `search` | 复用工具那套检索（含语义与降级口径） |
| 记忆库 | `entry` | 单条全文、来源、归档原因、是否已向量化 |
| 嵌入 | `status` | 状态灯（off/unconfigured/error/ready/partial）、模型、维度、用量、预算 |
| 嵌入 | `save` | 保存协议、地址、模型、维度、权重、限流参数（逐项校验范围） |
| 嵌入 | `save-secret` | 把 API 密钥写进部署的 `.env`，不落配置 |
| 嵌入 | `probe` | 发一条最小请求测连接，返回维度与耗时 |
| 嵌入 | `reindex` | 只补缺的向量（换模型会整仓重建） |
| 嵌入 | `presets` | 四套供应商预设：OpenAI / Ollama / LM Studio / 自定义 |

面板调用统一返回 `{ ok: true, data }` 或 `{ ok: false, error }`，失败不会把整页打回空白。

## 事件

`ink.memory.loaded` / `added` / `amended` / `archived` / `purged` / `recalled` / `evicted` / `ink.store.recovered` / `ink.embed.ready` / `ink.embed.failed` / `ink.embed.reindexed`。
载入、坏档恢复是 `preempt`，其余是 `flush`。

## 配置

配置路径都在 `worlds.thepalestink.*`，全部热改（下次工具调用即生效）。

### 记忆库

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | World 开关 |
| `maxEntries` | `500` | 未归档条目上限（1–100000） |
| `searchLimit` | `8` | `ink_search` / `ink_list` 的默认条数（1–50） |
| `defaultImportance` | `2` | 写入时未给重要度用的默认值（0–5） |
| `hardDeleteOnForget` | `false` | 是否允许 `ink_forget` 带 `purge` 真正删除 |

### 语义检索

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `semanticEnabled` | `false` | 是否启用语义检索；关着时一次嵌入请求都不发 |
| `embedProtocol` | `openai` | `openai`（`/embeddings`）或 `ollama`（`/api/embed`，404 退 `/api/embeddings`） |
| `embedBaseUrl` | `https://api.openai.com/v1` | 接口根地址；本地模型填 `http://127.0.0.1:11434` 之类 |
| `embedModel` | `text-embedding-3-small` | 模型名 |
| `embedDimensions` | `0` | 0 = 跟随模型；非 0 会校验返回值 |
| `embedApiKeySecret` | `THEPALESTINK_EMBED_KEY` | 密钥所在的**环境变量名**，不是密钥本身 |
| `semanticWeight` | `0.45` | 语义分权重（0–1），与字面分相加后排序 |
| `embedBatchSize` | `16` | 一次请求几条（1–64） |
| `embedTimeoutMs` | `20000` | 单次请求超时（1000–120000） |
| `embedConcurrency` | `1` | 同时最多几个请求（1–8） |
| `embedRequestsPerMinute` | `60` | 每分钟请求上限（6–6000），实际按 `60000/rpm` 排队 |
| `embedMaxRetries` | `2` | 429 / 5xx / 网络错的重试次数（0–5） |
| `embedDailyBudget` | `2000` | 每天最多几次嵌入请求（0–100000），到顶就停 |
| `embedAutoReindex` | `true` | 启动时自动补缺失向量（单次最多 200 条） |

密钥只走部署的 `.env`：面板「嵌入」页填写后会调用宿主的 `storeSecret`，配置里只留变量名。本地回环地址（127.0.0.1 / localhost）允许不带密钥。

## 存档

- 记忆正文：`<dataDir>/thepalestink/entries.json`，`schema` 为 `1`。
- 向量与用量账本：`<dataDir>/thepalestink/vectors.json`，`schema` 为 `1`；删它只会让下次重建向量，不动正文。
- 写盘先写 `.tmp` 再 rename，进程被杀不会留下半个文件。
- 读到坏档时改名为 `*.broken-<时间戳>`，从空库继续，并推一条恢复事件。
- 归档区只保留最近 200 条（置顶的除外），所以「归档」不是「永久保存」，要留就置顶。

## 边界

- 语义检索是**可选增强**，不是依赖：默认关闭，关着时只用字面匹配，不联网。
- 嵌入服务连不上时自动退回字面检索，回执会说明「语义检索这次没连上」，不会让整次查找失败。
- 不做重排（rerank）、不做多路召回融合：一条记忆一个向量，排序就是「字面分 + 语义分 + 重要度/置顶/新旧」。
- 不写密钥：环境提示词禁止把令牌、密码写进正文；嵌入密钥只入 `.env`。
- 不替别的 World 记状态：机械计算副本留在各自的 World 里，这里只放语义记忆。
- 单实例：多个 bot 各有一份 `dataDir` 下的存档，不做跨实例同步。

## 开发

```bash
pnpm typecheck                 # 主项目 + 面板两个 tsconfig
pnpm test                      # vitest，43 个用例
pnpm build:webui               # esbuild 打 dist/webui.js
node _dev/verify.mjs           # 无依赖行为自检（69 项，不需要 pnpm）
node _dev/gen-describe.mjs     # 重新生成 describe.json
```

本机 `pnpm` 会静默挂住，验证时用 npm 替身：

```bash
npm install --ignore-scripts --no-audit --no-fund
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.webui.json --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/esbuild/bin/esbuild src/webui/client.ts --bundle --format=esm --target=es2022 --platform=browser --outfile=dist/webui.js
```

改了工具、事件或 `src/ENV_PROMPT.md` 之后：

```bash
pnpm describe:extension <本包目录>
pnpm check:extension <本包目录>
```

## 已知简化

- 面板只读：能看、能搜、能配嵌入，但不在面板里直接增删改记忆（写入口只给模型）。
- 语义检索一条一个向量：长条目不切块，超长正文的语义会被平均掉；重要内容建议一条一件事。
- 中文靠 2-gram 放宽而不是分词器：覆盖不足一半仍会判「没命中」，同义词多写标签更稳。
- 容量淘汰按 `lastRecalledAt ?? updatedAt`，不区分种类；重要条目请置顶。
- 没有导出/迁移命令：换机就拷 `entries.json`（`vectors.json` 可丢）。
