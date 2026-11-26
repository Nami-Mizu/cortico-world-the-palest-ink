## 0.8.0

- **交接钩子换了用途**：`onHandoffEnded` 不再提醒「补写记忆」（交接前上下文快满时刚整理过，再催一次没意义），改为从「待办」与「偏好」两类记忆里各挑最多 3 条、拼成一条提要送进上下文，让交接后的对话接得上。两类都空就不发，免得空提要占上下文。
- **事件 `ink.reminder.handoff` 下线，改发 `ink.handoff.briefing`**（仍是 `preempt`）；提要只读，不动取用计数，也不参与淘汰。
- 配置键 `handoffReminder` 改名为 `handoffBriefing`（默认 `true`），旧键不再读取；含义从「提醒补写」变成「带上待办与偏好」。
- 提示词同步：删掉「交接后补写」，加「交接提要只是接着干的清单，不是新任务」。
- 一并包含 0.7.1：上下文提醒默认阈值 `75` → `20`（宿主约两成多就交接）。
- 测试：122 个用例；`_dev/verify.mjs` 122 项。

## 0.7.1

- 上下文提醒的默认阈值从 `75` 改成 `20`：宿主（Coopanion）在上下文窗口用到两成多时就交接，阈值 75 等于永远等不到；20 让提醒落在交接前后。
- 提示词补一句「这条提醒来得偏早、往往紧挨着交接」；配置项描述与 README / AGENTS / 设计文档同步。
## 0.7.0

- **情绪记忆**：条目新增 `mood` 字段（`warm` 温柔 / `happy` 开心 / `low` 低落 / `serious` 认真 / `playful` 玩笑 / `clingy` 黏人 / `neutral` 平静，默认 `neutral`）。`ink_remember` / `ink_amend` 可选填 `mood`，`ink_search` 可按情绪过滤；旧存档缺这个字段的按 `neutral` 读。
- **新工具 `ink_mood`**（只读）：回复前按这一句/上一句的情绪取 5 条最相关的记忆（同情绪、未归档，按重要度、取用次数、最近更新排），回执直接作为这次回复的素材。
- 情绪由**模型自己标**：宿主不提供情绪标签，模型判断语气后写入，回复前再按判断调 `ink_mood`；环境提示词加了「关于情绪」一节与「别整段复述回执」的口径。
- 面板：记忆库表格与抽屉显示情绪，统计行与 `snapshot` 带情绪分布（`moods`）；`ink_stats` 多一行「情绪：…」。
- 测试：122 个用例（world 34 / search 16）；`_dev/verify.mjs` 121 项。

## 0.6.1

- **导入后主动补向量**：只要语义开着且配好了，`data:import` 完成后立即启动一次**全量**补向量（`backfill(MAX_SAFE_INTEGER)`），不再看 `embedAutoReindex`（那个开关只管「启动时补」），也不受启动时 200 条的上限。
- 回执与面板会告诉这次补不补、还剩几条：`ImportResponse.vectorize = { started, pending, reason? }`；语义没开或没配好时给出原因（「语义检索没开」/「嵌入还没配好」）。
- 导入的写入路径没变：仍然先 `store.backup()`，`merge` 本地优先、`replace` 要打「替换」。
- 测试：115 个用例（world 30）；`_dev/verify.mjs` 112 项。

## 0.6.0

- **事件默认静音**：新增配置 `eventLevel`（`quiet` / `normal`，默认 `quiet`）。`quiet` 只发系统事件（`loaded`、`store.recovered`、`reminder.*`、`embed.*`、`evicted`、`maintenance.swept`）；`normal` 才把 `added` / `amended` / `recalled` / `purged` / `archived` 这些「自己动作的回声」也发出来。`describe.json` 仍声明全部 15 个事件。
- **自动整理合并成一条事件**：`runMaintenance()` 一轮只推一条 `ink.maintenance.swept`（归档数、久未取用/内容重复各几条、最多 5 个样本 id），不再逐条发 `archived`。
- **写入前查重**（`src/dedupe.ts`，纯函数）：`simhash64()` 指纹（中文 2-gram + 拉丁词，FNV-1a 64 位）+ Jaccard + 包含度三把尺子；`dedupeMode`（`warn` / `merge` / `off`，默认 `warn`）与 `dedupeThreshold`（默认 0.82）可热改；`ink_remember` 新增 `force` 参数。命中时 `warn` 不写、回旧 id 与相似度；`merge` 把新正文追加进旧条目。
- **数据面板导入导出**（第四个页签 `data`，唯一会改存档的人工操作）：
  - `status` / `export`（快照 JSON，含归档；不含向量；前端 Blob 下载）/ `preview`（预演，与真正导入共用 `planImport`）/ `import`。
  - `merge` 本地优先：同 id 跳过、内容几乎重复跳过、只补新的；`replace` 让本地只剩文件里那些，必须输入「替换」，写盘前自动备份成 `entries.json.bak-<时间戳>`。
  - 导入上限 5000 条；非法条目只计数不中断；`replace` 后清理孤儿向量。
- 测试：114 个用例（world 29 / dedupe 9 / transfer 6 / starmap-layout 10 / search 13 / cron 12 / embedding 11 / maintenance 15 / vector 6）；`_dev/verify.mjs` 110 项。

## 0.5.0

- **记忆星图**：第三个页签 `starmap`（只读）。每条记忆一个点，标签画成引力圈，**不画线**。
  - 布局是纯函数 `layoutStarMap()`：`hash32(id)` 当种子 + 固定 48 轮排斥松弛，同一份数据每次结果一致（刷新不漂移）。
  - 最多 8 个标签圈（按出现次数）；无标签的点落内圈；点的颜色 = 种类、大小 = 重要度、实心环 = 置顶、虚线圈 = 已过期、灰 = 归档。
  - 上限 800 点（同时不超过 `maxEntries`）；超出时显示「只画了前 N 条」。
  - 客户端用 canvas，支持滚轮缩放（0.6–3）、拖拽平移、悬停提示、点开复用记忆库详情卡。
- 服务端新增面板方法 `starmap:map` 与 `starmap:entry`；新增 `src/webui/starmap-layout.ts`（无 DOM、测试与面板共用）。
- 测试：90 个用例（world 23 / starmap-layout 10 / search 13 / cron 12 / embedding 11 / maintenance 15 / vector 6）；`_dev/verify.mjs` 99 项。

## 0.4.0

- **时效性记忆**：`ink_remember` / `ink_amend` 增加可选 `expiresInDays`（0 = 永久，上限 3650）；条目记 `ttlDays` 与 `expiresAt`，按 `ctx.timezone` 算到期日。
- **新工具 `ink_expired`**（只读）：分页列出已过期、未归档的条目，带逾期天数与 `⏳` 标记；没有过期条目时明确回「没有过期的记忆」。
- **过期不删除**：过期条目仍可检索与取用，摘要行标「⏳ 已过期」，打分降 0.8（排在新鲜条目之后）。
- **整理时间报数量**：`writeCron` 到点时若有过期条目，提醒改为「记忆库里有 N 条已经过期，用 ink_expired 看全部」，并给出「续期改 expiresInDays / 不要了用 ink_forget」两条出口；没配 cron 时靠 `ink_stats` 与面板兜底。
- **续期**：`ink_amend` 给 `expiresInDays` 才重算到期日（0 取消时效），改正文不会顺延有效期。
- **面板**：记忆库页新增「过期待整理」计数、条目抽屉的「有效期」行、结果行「已过期」标记；`snapshot` 带 `expired: { count, items }`。
- 环境提示词新增「关于时效」小节与 `{{thepalestink.expired}}` 占位符；`ink_stats` 报「过期待整理：N 条」。
- 测试：79 个用例（world 22 / search 13 / cron 12 / embedding 11 / maintenance 15 / vector 6）；`_dev/verify.mjs` 94 项。

## 0.3.0

- **定时提醒**：`writeCron`（5 段 cron，按 `ctx.timezone`）到点推 `ink.reminder.schedule`，可附 `writeCronNote`；同一分钟只推一次。
- **上下文提醒**：事件流估算用量 ≥ `contextReminderPercent` 时推 `ink.reminder.context`，带冷却；拿不到 `contextWindow` 就不打扰。
- **交接提醒**：`onHandoffEnded` 推 `ink.reminder.handoff`（preempt），并重置估算起点。
- **自动归档**：
  - 过期：重要度 ≤ `autoArchiveImportance` 且 ≥ `autoArchiveAgeDays` 未被取用。
  - 重复：同种类、正文指纹 Jaccard ≥ `conflictSimilarity` 时留较重要/较新的那条。
  - `pinned` 与重要度 5 永不自动归档；只归档不删除，归档后仍可 `ink_recall`。
- **面板**：记忆库页新增只读「写记忆的节奏」卡片（下次触发、上下文估算、最近提醒、最近归档样本）。
- 新增第二个配置组 `world:thepalestink.rhythm`（11 个热改项）；三个新事件，事件总数 14。
- 新增纯函数模块 `src/cron.ts`、`src/maintenance.ts`；`tick()` / `runMaintenance()` 公开可测。
- 测试：77 个用例（world 20 / search 13 / cron 12 / embedding 11 / maintenance 15 / vector 6）；`_dev/verify.mjs` 87 项。

## 0.2.0

- **语义检索（可选）**：接入嵌入模型后，按余弦相似度排序；未配置或连不上时自动退回字面检索，不阻断写入与查找。
  - 协议：OpenAI 兼容 `/embeddings` 与 Ollama `/api/embed`（404 时退回 `/api/embeddings`）。
  - 限流：并发、每分钟请求数、超时、重试退避（尊重 `Retry-After`）、每日预算。
  - 密钥只写部署 `.env`（`ctx.storeSecret`），配置里只留变量名。
  - 向量落 `<dataDir>/thepalestink/vectors.json`，换模型/地址/维度自动整仓作废。
- **中文长句检索**：字面检索增加 2-gram 覆盖打分，长句不再因为切词不齐而整句落空；拉丁词仍是 AND。
- **两个面板**：
  - 「记忆库」（只读）：规模、种类分布、标签榜、最近条目、检索、单条全文。
  - 「嵌入」：状态、供应商预设（OpenAI / Ollama / LM Studio / 自定义）、接口与开关、限流与预算、密钥保存、测试连接、重建向量。
- 三个新事件：`ink.embed.ready` / `ink.embed.failed` / `ink.embed.reindexed`。
- 十四个新配置项，全部热改。
- 测试：43 个用例（world 13 / search 13 / embedding 11 / vector 6）；`_dev/verify.mjs` 扩到 69 项。

## 0.1.0

- 首个版本：「淡墨 · 记忆库」World 框架。
- 七个工具：`ink_remember` / `ink_search` / `ink_recall` / `ink_amend` / `ink_forget` / `ink_list` / `ink_stats`。
- 八个事件：`ink.memory.loaded` / `added` / `amended` / `archived` / `purged` / `recalled` / `evicted` / `ink.store.recovered`。
- 存档 `<dataDir>/thepalestink/entries.json`（`schema: 1`），原子写入，坏档自动备份。
- 容量上限淘汰（最久未取用优先，置顶保护）与 200 条归档区。
- 五个热改配置：`enabled` / `maxEntries` / `searchLimit` / `defaultImportance` / `hardDeleteOnForget`。
- 中文环境提示词：写什么、怎么写、怎么读、边界。
