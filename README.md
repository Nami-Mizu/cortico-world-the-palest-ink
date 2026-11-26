# 淡墨 · The Palest Ink

一句中文说明：一座能写、能查、能改的长期记忆库——把「以后还会用到的事」记下来，下次对话还在。

> 名字取自一句谚语：*The palest ink is better than the best memory.*（最淡的墨水，胜过最好的记性。）

## 它做什么

- 模型可以把事实、事件、偏好、待办写进记忆库，条目带标签、来源、重要度、置顶。
- 按关键词与标签检索（拉丁词是「都要命中」，中文按 2-gram 放宽），命中只回摘要行，需要全文再按 id 取用。
- 语义检索可选：接一个嵌入模型（OpenAI 兼容接口，或本地的 Ollama / LM Studio）后，「意思近」的条目也能找回来；没配就纯字面匹配，照常可用。
- 嵌入调用带限流：并发、每分钟请求数、超时、重试退避、每日预算，防止把 API 打到 429、也防止账单失控。
- 记错了可以按 id 修订；用不着了先归档、必要时才物理删除。
- 可以给一条记忆标**有效期**（`expiresInDays`，按天）：到期不会被删，只是会在「整理记忆时间」被提醒一次，由模型决定续期还是归档。
- 容量有上限（默认 500 条），满了淘汰**最久没被取用**的条目到归档区，置顶条目不淘汰。
- 会挑时候提醒模型写：定时（cron，如 `30 7 * * *`）、上下文估算过阈值。定时那次会顺带报「有几条已经过期」；提醒只是提示，不写也行。交接后不催写，而是自动带上 3 条待办与 3 条偏好，接上前文。
- 会自动归档两类记忆：久没被取用且重要度低的；两条内容几乎重复的（留较新/较重要的）。置顶与重要度 5 永不自动动。
- 写入前会查重：几乎同一句的重复记忆会被拦下（给旧 id 与相似度），模型可以改旧的、加 `force` 硬写，或让 `merge` 模式直接并进旧条目。
- 事件默认**静音**：模型自己的写入/取用/修订不发事件，只有载入、坏档恢复、提醒、嵌入、容量淘汰与自动整理的聚合回执会进时间线（配置 `eventLevel: normal` 可开回逐条）。
- 四个面板：「记忆库」看条目、检索与「写记忆的节奏」；「星图」把每条记忆画成一个点、标签画成引力圈；「嵌入」引导人类配置供应商、测连接、看用量；「数据」导出快照、从文件导入（先预演、写盘前自动备份）。
- 存档是人类可读的 JSON，坏档会先改名备份再从空库继续，不会静默丢数据。

## 装

1. 把包目录（或发布的 npm 包）装进 Cortico 的扩展目录。
2. 重启宿主。
3. 到 World 页启用「淡墨」。
4. 再重启一次，让 World 的工具与环境提示词生效。

启用直达：`world:thepalestink`（World 总览里的一张卡，卡片上有「记忆库」「星图」「嵌入」「数据」四个页签）。

## 工具

| 工具 | 标签 | 用途 |
| --- | --- | --- |
| `ink_remember` | write | 写一条记忆，返回 id；可选 `expiresInDays` 标有效期、`mood` 标情绪；写入前查重，重复时回失败与旧 id，带 `force` 可硬写 |
| `ink_search` | read | 按关键词/标签/种类/情绪检索，回摘要行；开语义时同时算向量分，过期条目标「⏳」 |
| `ink_recall` | read | 按 id 读全文，并记一次取用 |
| `ink_mood` | read | 按情绪取回几条（缺省 5 条）最相关的记忆，回复前用 |
| `ink_amend` | write | 按 id 修订正文、标签、种类、情绪、来源、重要度、置顶、有效期（`expiresInDays`，0 = 永久） |
| `ink_forget` | write | 归档一条记忆；配置允许时可物理删除 |
| `ink_expired` | read | 列出已过期、未归档的条目（分页），带逾期天数 |
| `ink_list` | read, snapshot | 按最近修订倒序列出 |
| `ink_stats` | read, snapshot | 规模、种类与情绪分布、标签榜、被取用最多、过期待整理、语义索引状态、存档路径 |

## 面板

| 页签 | 方法 | 说明 |
| --- | --- | --- |
| 记忆库 | `snapshot` | 规模、过期待整理、种类与情绪分布、标签榜、最近 30 条、语义状态、写记忆的节奏 |
| 记忆库 | `search` | 复用工具那套检索（含语义与降级口径） |
| 记忆库 | `entry` | 单条全文、来源、归档原因、是否已向量化 |
| 星图 | `map` | 每条记忆一个点（正文截 60 字）、标签计数、按种类/标签/归档过滤 |
| 星图 | `entry` | 点开看单条全文（和记忆库同一个读法） |
| 嵌入 | `status` | 状态灯（off/unconfigured/error/ready/partial）、模型、维度、用量、预算 |
| 嵌入 | `save` | 保存协议、地址、模型、维度、权重、限流参数（逐项校验范围） |
| 嵌入 | `save-secret` | 把 API 密钥写进部署的 `.env`，不落配置 |
| 嵌入 | `probe` | 发一条最小请求测连接，返回维度与耗时 |
| 嵌入 | `reindex` | 只补缺的向量（换模型会整仓重建） |
| 嵌入 | `presets` | 四套供应商预设：OpenAI / Ollama / LM Studio / 自定义 |
| 数据 | `status` | 存档与向量文件、条数、大小、上次备份/导入时间、导入上限 |
| 数据 | `export` | 导出快照 JSON（含归档可选），前端直接下载；不含向量 |
| 数据 | `preview` | 导入预演：新增/跳过/重复/非法计数与样本，和真正导入用同一套计划 |
| 数据 | `import` | `merge`（本地优先）或 `replace`（要输入「替换」确认）；写盘前自动备份 |

星图只画点、不画线：每个标签是一个圈（按出现次数排在外圈），每条记忆落在它所属标签圈心的中点附近；点的大小是重要度，实心环是置顶，虚线圈是已过期，灰点是归档。位置由条目 id 的哈希决定，同一份数据每次画出来一样。可以拖拽平移、滚轮缩放，点圆点读全文。上限 800 个点（超出只进列表）。

记忆库面板另有一块只读的「写记忆的节奏」：定时是否到点、下次什么时候、上下文估到多少、最近一次提醒、上次自动归档了几条、为什么。改这些要去 World 配置页（同样是只读展示，改不改由人定）。

面板调用统一返回 `{ ok: true, data }` 或 `{ ok: false, error }`，失败不会把整页打回空白。

## 事件

`ink.memory.loaded` / `added` / `amended` / `archived` / `purged` / `recalled` / `evicted` / `ink.store.recovered` / `ink.embed.ready` / `ink.embed.failed` / `ink.embed.reindexed` / `ink.reminder.schedule` / `ink.reminder.context` / `ink.handoff.briefing` / `ink.maintenance.swept`。
载入、坏档恢复、交接提要是 `preempt`，其余是 `flush`。

默认 `eventLevel: quiet`：`added` / `amended` / `recalled` / `purged` / `archived` 不发（那是模型自己动作的回声），自动整理也只在**一轮结束时发一条** `ink.maintenance.swept`（归档几条、久未取用/内容重复各几条、最多 5 个样本 id）。`describe.json` 仍声明全部 15 个事件。

## 配置

配置路径都在 `worlds.thepalestink.*`，全部热改（下次工具调用即生效）。

### 记忆库

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | World 开关；定义里恒为关，装好后到 World 页打开 |
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

### 写入与事件

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `eventLevel` | `quiet` | `quiet` 只发系统事件；`normal` 把模型动作的回声也发出来（写代码调试时用） |
| `dedupeMode` | `warn` | 写入前查重：`warn` 拦下并提示旧 id、`merge` 并进旧条目、`off` 不查 |
| `dedupeThreshold` | `0.82` | Jaccard 相似度阈值（0.5–0.99）；另有「小集合被包含 ≥92%」与「simhash 汉明 ≤4 位」两条判重 |

### 写记忆的节奏

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `writeCron` | `''`（关） | 定时提醒的 cron，五段（分 时 日 月 周），如 `30 7 * * *`；留空不提醒 |
| `writeCronNote` | `''`（空） | 定时提醒时附在后面的自定义提示，比如「重点回顾项目约定」 |
| `contextReminderPercent` | `20` | 上下文估算到窗口的百分之几时提醒（0–95，0 = 关）；宿主约 20% 多就交接，所以默认 20 |
| `contextReminderCooldownMinutes` | `60` | 两次上下文提醒之间至少隔多久（5–1440 分钟） |
| `handoffBriefing` | `true` | 交接完成后带上「待办」与「偏好」各 3 条提要（只读，不催写） |
| `autoArchiveEnabled` | `true` | 自动归档总开关 |
| `autoArchiveAgeDays` | `30` | 多少天没被取用算「久远」（1–3650） |
| `autoArchiveImportance` | `1` | 重要度不高于几分才算「不重要」（0–4） |
| `autoArchiveConflicts` | `true` | 是否归档内容几乎重复的旧条目 |
| `conflictSimilarity` | `0.82` | 重复判定阈值（0.5–0.99，Jaccard 相似度） |
| `maintenanceIntervalMinutes` | `60` | 自动归档检查的间隔（5–1440 分钟） |

提醒的两种时机：`writeCron` 到点；上下文**估算**过阈值。`onHandoffEnded` 不提醒写记忆（交接前刚整理过），而是从「待办」与「偏好」里各挑 3 条送进上下文，让接下来的对话接得上；库为空就不发。宿主没有「交接开始前」的钩子，所以提要落在交接后的第一批。上下文 token 数是按交接以来事件文字估的（中日韩一字一 token、其余 3.6 字符一 token），只用于阈值，**不是**宿主的精确用量。

## 存档

- 记忆正文：`<dataDir>/thepalestink/entries.json`，`schema` 为 `1`。
- 向量与用量账本：`<dataDir>/thepalestink/vectors.json`，`schema` 为 `1`；删它只会让下次重建向量，不动正文。
- 写盘先写 `.tmp` 再 rename，进程被杀不会留下半个文件。
- 读到坏档时改名为 `*.broken-<时间戳>`，从空库继续，并推一条恢复事件。
- 归档区只保留最近 200 条（置顶的除外），所以「归档」不是「永久保存」，要留就置顶。
- 导入覆盖前会把当前存档复制成 `entries.json.bak-<时间戳>`；合并导入也会备份（同目录、同前缀）。

## 边界

- 语义检索是**可选增强**，不是依赖：默认关闭，关着时只用字面匹配，不联网。
- 嵌入服务连不上时自动退回字面检索，回执会说明「语义检索这次没连上」，不会让整次查找失败。
- 不做重排（rerank）、不做多路召回融合：一条记忆一个向量，排序就是「字面分 + 语义分 + 重要度/置顶/新旧」。
- 不写密钥：环境提示词禁止把令牌、密码写进正文；嵌入密钥只入 `.env`。
- 不替别的 World 记状态：机械计算副本留在各自的 World 里，这里只放语义记忆。
- 单实例：多个 bot 各有一份 `dataDir` 下的存档，不做跨实例同步。
- 过期不自动删：到期只是标记与提醒，留不留由模型判断（续期 `ink_amend`，不要了 `ink_forget`）；**事实是否还成立，这个 World 不判断**。
- 导入导出只在面板里：工具参数塞不下几百条 JSON，也不该让模型转述整份存档。覆盖导入是唯一会「改存量」的人工操作，所以必须二次确认。

## 开发

```bash
pnpm typecheck                 # 主项目 + 面板两个 tsconfig
pnpm test                      # vitest，122 个用例
pnpm build:webui               # esbuild 打 dist/webui.js
node _dev/verify.mjs           # 无依赖行为自检（122 项，不需要 pnpm）
node _dev/gen-describe.mjs     # 重新生成 describe.json
```

`packageManager` 锁的版本要跟本机 `pnpm --version` 一致（当前 `pnpm@12.23.0`）。对不上时 pnpm 不是报错，而是**静默挂住**——它跑去下载字段里那个版本，下不到就一直等。真遇到时改用 npm 替身：

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

本机不装宿主依赖也能跑第②级（用宿主源码做干装载与 describe 比对）：

```bash
node node_modules/tsx/dist/cli.mjs _dev/host-check.ts
```

## 已知简化

- 面板只读：能看、能搜、能配嵌入，但不在面板里直接增删改记忆（写入口只给模型）。
- 语义检索一条一个向量：长条目不切块，超长正文的语义会被平均掉；重要内容建议一条一件事。
- 中文靠 2-gram 放宽而不是分词器：覆盖不足一半仍会判「没命中」，同义词多写标签更稳。
- 容量淘汰按 `lastRecalledAt ?? updatedAt`，不区分种类；重要条目请置顶。
- 上下文提醒是**估算**：宿主没把 token 用量交给 World，这里按交接以来事件的字数换算，工具回执不计入，所以只会低估。真要精确，等宿主开放用量接口。
- 自动归档是启发式：重复判定用 2-gram/词的 Jaccard，同义改写抓不到；「事实冲突」判断只看正文相似度，不做语义比对。**这一点没变**：0.4.0 的时效只是提醒模型来复核，不替它判断冲突。
- 有效期按**天**算，写入时一次定下（`ttlDays` + `expiresAt`）；没有「每周」「到下个月底」这类表达，也没有按事件触发的到期。
- 过期降权是固定 `-0.8`（排在新鲜条目之后，但不隐藏），不是按逾期时长递增。
- 星图是**静态布局**：位置由 id 哈希 + 一次排斥松弛算出来，不跟着新条目「生长」；最多画 800 个点，标签圈最多 8 个（其余标签的点仍会画，只是没有圈）。
- 查重只比正文：不比较标签/来源/重要度，也不做语义判断——「换了关键信息」的改写（周三→周五）会被当成新条目，而不是冲突提醒。
- 去重是拦写入，不是合并重复：`merge` 模式只是把新正文追加到旧条目后面（超长会失败），不会重写标签或重要度。
- 导入只认淡墨快照（或「有 entries 数组」的 JSON），不做 Markdown/CSV 导入；`replace` 是全量覆盖，没有「按标签导入」。
