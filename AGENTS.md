# 给接手这个包的人 / 模型

- `cortico.api` 是 6（world 契约版本）。宿主升契约时先跑 `pnpm check:extension <本包目录>` 看它打印的版本。
- 改了工具、事件或 `src/ENV_PROMPT.md`，要重跑 `pnpm describe:extension <本包目录>`，否则 `describe.json` 与代码不一致（check 会报）。本机没有 pnpm 时用 `node _dev/gen-describe.mjs` 重生成。
- World id 固定 `thepalestink`（全小写、无连字符：WebUI 页 id 是 `world:thepalestink`，协议只接受小写字母数字与 `-`；事件 type 段内也不许连字符）。工具前缀固定 `ink_`，配置路径因此是 `worlds.thepalestink.*`。
- 九个工具：`ink_remember` / `ink_search` / `ink_recall` / `ink_mood` / `ink_amend` / `ink_forget` / `ink_expired` / `ink_list` / `ink_stats`。面板四个页签：`library`（记忆库，只读）、`starmap`（星图，只读）、`embedding`（嵌入配置）、`data`（导入导出）。
- 数据两份：`<dataDir>/thepalestink/entries.json`（`MEMORY_SCHEMA = 1`，删它等于清空记忆库）与 `<dataDir>/thepalestink/vectors.json`（`VECTOR_SCHEMA = 1`，删它只丢向量、不丢正文）。schema 升级要写迁移，不要静默丢弃旧字段。
- 导入前会写备份：`entries.json.bak-<base36 时间戳>`，`store.backup()` 返回路径，`dataStatus().lastBackup` 给面板显示。备份只在导入时生成，不自动清理。
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
- 环境提示词在 `src/ENV_PROMPT.md`，占位符 `{{thepalestink.count}}` / `{{thepalestink.archived}}` / `{{thepalestink.maxEntries}}` / `{{thepalestink.topTags}}` / `{{thepalestink.semantic}}` / `{{thepalestink.expired}}` 由 `envPromptVars()` 提供。改占位符名要两边一起改。
- 面板：服务端在 `src/world.ts` 的 `invoke()`（`library` / `starmap` / `embedding` / `data` 各一个分支），客户端在 `src/webui/panels/*.ts`，打包入口 `src/webui/client.ts` → `dist/webui.js`（manifest 的 `cortico.webUiClient`）。客户端只能 `import type`，不能 import 服务端模块；面板返回统一 `{ok,data}|{ok:false,error}`，别抛异常穿透。
- 面板加方法要改两处：`invoke()` 的 switch 与 `panels` 声明里的 `getMethods`（省略 `getMethods` 就只接受 POST）。
- 改完面板必须 `pnpm build:webui`（或 `node node_modules/esbuild/bin/esbuild src/webui/client.ts --bundle --format=esm --target=es2022 --platform=browser --outfile=dist/webui.js`），否则页面加载的是旧 bundle。
- 文案口径：模型对**人类**称「对方」，模型自己称「你」；回执不是正文，不要整段贴回。

## 提醒与自动归档

- 节奏相关的 11 个配置在第二个配置组 `INK_RHYTHM_CONFIG_GROUP`（id `world:thepalestink.rhythm`，owner 仍是 `world:thepalestink`；路径都落在 `worlds.thepalestink.` 下）。`webUi().config` 是 `[INK_CONFIG_GROUP, INK_RHYTHM_CONFIG_GROUP]` 两组一起给。
- cron 解析在 `src/cron.ts` 是纯函数：`parseCron` 五段（分 时 日 月 周），支持 `*`/`?`/数字/`a-b`/`a,b`/`/n`，周日 `7` 折成 `0`；日与周同时限定时「满足其一」；`nextCronMatch` 逐分钟扫（最多 370 天）。**没有秒级、没有 `@daily` 别名、不处理夏令时**。
- 调度器在 `world.start()` 里 `setInterval`（默认 30 秒，`unref` 掉，不吊住宿主），调 `tick()`；`tick()` 是公开的、`now` 可注入，测试别真等。同一分钟只推一次（key 是 `YYYY-MM-DDTHH:mm`）。
- 三种提醒：`writeCron` 到点（`ink.reminder.schedule`）、上下文估算过 `contextReminderPercent`（`ink.reminder.context`，冷却 `contextReminderCooldownMinutes`）、`onHandoffEnded`（`ink.reminder.handoff`，`preempt`）。**宿主没有「交接开始前」钩子**，交接提醒只能落在交接后第一批；`onHandoffEnded` 同时把 `handoffCursor` 移到最新，重置估算。
- 上下文 token 是**估算**（`estimateTokens`：中日韩一字一 token、其余 3.6 字符一 token，向上取整），数据来自 `host.store.range({fromCursor})` 的事件文字，只取最后 2000 条；工具回执不在事件里，所以只会低估。别把它当宿主的精确用量。
- 自动归档判定在 `src/maintenance.ts` 是纯函数 `planMaintenance(entries, settings, now)`，`world.runMaintenance()` 才落盘。两条规则：`importance <= autoArchiveImportance` 且按 `lastRecalledAt ?? updatedAt` 算 ≥ `autoArchiveAgeDays`（stale）；同 kind、Jaccard ≥ `conflictSimilarity` 的取较旧/较不重要者（conflict）。**置顶与重要度 5 永不自动归档**（`SACRED_IMPORTANCE = 5`）。
- 自动归档只调 `store.archive()`（不 purge），所以归档后仍能 `ink_recall` 读到；容量淘汰、自动归档共用 `archiveReason` 字段，别混用。
- `maintenanceIntervalMinutes` 节流 `runMaintenance('timer')`；启动时跑一次 `runMaintenance('start')`（关机期间也该过期）；面板没有手动触发按钮，要手动跑就写脚本构造 world 调公开的 `runMaintenance('manual')`。
- 改这两块之后先跑 `node _dev/verify.mjs`（有 cron/上下文/交接/归档的用例），再跑 vitest 的 `cron.test.ts` / `maintenance.test.ts`。

## 时效性记忆

- `MemoryEntry` 有两个新字段：`ttlDays`（0 = 永久）与 `expiresAt`（`string | null`）。`MAX_TTL_DAYS = 3650`；`isExpired()` / `overdueDays()` 在 `src/types.ts` 里是纯函数，拿传入的时钟比 `expiresAt`。
- 写入与修订都用可选参数 `expiresInDays`：`store.add()` 用**真实时钟**（`new Date()`，不是测试注入的 `world.now()`）算到期日；`store.update()` 只在传了 `expiresInDays` 时重算，`0` 是取消时效，**改正文不会顺延有效期**。`coerceEntry()` 会给旧档补 `ttlDays: 0`，`ttlDays > 0` 而缺 `expiresAt` 时从 `createdAt` 推。
- 过期**不是删除**：`store.expired(now)` 只列未归档、按 `expiresAt` 升序；检索照常命中，`SearchHit.expired = true` 并扣 `EXPIRED_PENALTY = 0.8`（排在新鲜条目之后，但不隐藏）。别改成「过期就不返回」——用户选的是「标出来 + 略降权」。
- `ink_expired` 是只读工具（`limit` 1–50、`offset` 0–10000），先给总数与逾期天数，没条目时回「没有过期的记忆」。处理出口只有两个：`ink_amend` 改 `expiresInDays` 续期，`ink_forget` 归档；**不要**替模型自动续期或自动归档。
- 定时提醒到点时先看 `store.expiredCount(now)`：有过期条目就把文案换成「N 条已经过期，用 ink_expired 看全部……」；没有才说「花一分钟回顾」。没配 `writeCron` 就不主动弹过期，靠 `ink_stats` 与面板兜底。
- 面板：`snapshot.expired = { count, items（前 5 条） }`，条目抽屉有「有效期」行；`ink_stats` 报「过期待整理：N 条」；环境提示词有 `{{thepalestink.expired}}`。
- 明确不做：不做逐条「已通知」去重（cron 就是整理时间，每次都报未处理数量）、不自动归档过期条目、不判断事实是否还成立。要改事实就 `ink_amend` 正文。
- 改这块先跑 `node _dev/verify.mjs`（有时效用例），再跑 `tests/world.test.ts` 里「过期条目」「不填 expiresInDays 永不过期」两例；测试要模拟时间流逝，得改 `reminderWorld` 那个 `now` 返回的 Date 对象本身（`clock.setTime(...)`），只把 `tick(now)` 传成未来时间不够。

## 事件档位与查重

- 事件有两个档位（配置 `eventLevel`，默认 `quiet`）：`quiet` 只发系统事件——`loaded`、`store.recovered`、`reminder.*`、`embed.*`、`evicted`、`maintenance.swept`；`normal` 才把 `added` / `amended` / `recalled` / `purged` / `archived` 这些「自己动作的回声」也发出来。`emitTool()` 是回声的统一出口，别在工具里直接 `emit()`。
- `runMaintenance()` **一轮只发一条** `ink.maintenance.swept`（归档数、久未取用/内容重复各几条、最多 5 个样本 id），不再逐条发 `archived`。时间线是给模型读的，不是审计日志。
- `describe.json` 仍声明全部 15 个事件——声明是「可能发」，文档才是「默认发什么」，别为了静音去删声明。
- 查重在 `src/dedupe.ts`（纯函数）：`fingerprint()` 来自 `src/maintenance.ts`（拉丁词 + 中日韩相邻两字），三把尺子——Jaccard ≥ `dedupeThreshold`（默认 0.82）、小集合被大集合包含 ≥ `DEDUPE_CONTAINMENT = 0.92`、或 simhash 汉明 ≤ `DEDUPE_HAMMING = 4`；特征少于 `MIN_FEATURES = 3` 不判（短句撞车太多）。
- 查重只比**同 kind、未归档、未置顶**的条目，`excludeId` 用来跳过自己。`dedupeMode`：`warn`（默认，拦下并回旧 id + 相似度）、`merge`（把新正文追加进旧条目，超 `MAX_TEXT_LENGTH` 回失败）、`off`。`ink_remember` 的 `force: true` 只在 warn 档有意义。
- 判重的口径是「别写第二份」，不是「判断事实冲突」：换了关键信息的改写（周三→周五）会被当成新条目。别顺手把它扩成语义冲突判定——那是 0.4.0 明确不做的事。

## 导入导出

- 走面板（`invoke('data', ...)`），**不走工具**：几百条 JSON 塞不进工具参数，也不该让模型转述整份存档。
- `src/transfer.ts` 是纯函数：`buildSnapshot()` / `parseSnapshot()` / `planImport()` / `normalizeCandidate()`。预演与真正导入**共用** `planImport`，所以面板上看到的数字就是会写进去的数字；改导入逻辑只改这一处。
- `merge` 是本地优先：同 id 跳过、内容与本地几乎重复跳过、只补新的；`replace` 让本地只剩文件里那些，**必须**收到 `confirm === "替换"`（`collapse()` 后比较），且写盘前 `store.backup()`。
- 快照只含正文与元数据（不含向量）。`replace` 之后要 `vectors.prune(new Set(存活 id))`，否则旧 id 的向量会残留。
- **导入成功后主动补向量**：只要 `semanticEnabled` 且嵌入配好，`importMemory()` 末尾就 `backfill(Number.MAX_SAFE_INTEGER)` 跑一次全量（`startVectorize()` 决定要不要跑、还剩几条）；**不看 `embedAutoReindex`**——那个开关只管「启动时补」。语义没开/没配好时回 `vectorize.reason` 说明原因，别静默跳过。
- 补向量是后台跑（`void`），别在导入回执里等它；要看结果就刷新「嵌入」页或 `data:status` 的 `vectorCount`。
- 导入上限 `MAX_IMPORT_ENTRIES = 5000`；非法条目（缺 id/正文）只计数，不中断整批。

## 记忆星图

- 页签 `starmap`，只读。服务端 `starMap()` 在 `src/world.ts`，布局是纯函数 `layoutStarMap()` 在 `src/webui/starmap-layout.ts`（无 DOM、无宿主 import，`tests/starmap-layout.test.ts` 与 `_dev/verify.mjs` 都直接 import 它）。
- **不画线**：位置 = `hash32(id)` 当种子 + 固定 48 轮排斥松弛，同一份数据每次算出来完全一样；数据变了才动。别加「每次随机抖动」或「按时间漂移」，否则刷新就跳。
- 标签圈最多 `MAX_ANCHORS = 8` 个（按出现次数取前 8）；标签多于 8 个时其余标签的点照画、只是没有圈。无标签的点落内圈。
- 点的视觉编码：颜色 = `kind`、半径 = `nodeRadius()`（重要度 + 置顶加成）、实心外环 = 置顶、虚线外环 = 已过期、灰 = 归档。
- 上限 `MAX_LAYOUT_POINTS = 800`，同时不超过 `worlds.thepalestink.maxEntries`；`truncated` 为真时面板显示「只画了前 N 条」。
- 面板用 canvas（不是 SVG）：500+ 点每帧重绘时 SVG 节点会卡；缩放 0.6–3 倍、拖拽平移、点中后 `invoke('entry')` 复用 `library` 的详情卡。
- 服务端只返回点、标签圈与计数，**不返回坐标**——布局在客户端算，服务端不缓存。改 `panel-types.ts` 的 `StarPoint` 要同步改两端。
- 面板客户端只能 `import type`；`ui.pill` 的 tone 只有 `'on' | 'off' | 'plain'`。

## 情绪记忆

- 情绪词表固定在 `src/types.ts` 的 `MEMORY_MOODS`（`warm` / `happy` / `low` / `serious` / `playful` / `clingy` / `neutral`），中文名在 `MOOD_LABELS`；`MemoryEntry.mood` 默认 `neutral`，旧档由 `coerceEntry()` 补。
- 情绪是**模型自己标的**：宿主没有情绪字段（Cortico 契约 6 的 `World` / `WorldHost` / `RunPhase` 都没有），所以不要去找「宿主提供的情绪标签」。`ink_remember` / `ink_amend` 的 `mood` 由模型填，`ink_mood` 只负责按情绪取回。
- `ink_mood` 是只读工具：`mood` 必填、`limit` 1–20（缺省 5），排序在 `pickByMood()`（`src/search.ts`）——只取未归档、严格同情绪，按重要度 → 取用次数 → `updatedAt` → id。回执只是素材，提示词里明确要求「不要整段复述，也不要当成新消息回应」。
- 情绪**不参与**容量淘汰、自动归档、查重打分；它只是检索的一个过滤维度。`ink_search` 的 `mood` 过滤与 `ink_mood` 是两条路：前者可与关键词组合，后者就是「回复前取 5 条」的快捷方式。
- 面板：记忆库表格有一列「情绪」，抽屉有「情绪」行，`snapshot.moods` 给 `{ mood, label, count }[]`；`ink_stats` 多一行「情绪：…」。改 `PanelEntry` 要同步 `panel-types.ts` 与 `panelEntry()` 两端。
- 改这块先跑 `node _dev/verify.mjs`（有情绪段），再跑 `tests/search.test.ts` 的「情绪过滤与取回」与 `tests/world.test.ts` 的「情绪记忆」四条。

## 验证到哪一级

- 行为自检：`node _dev/verify.mjs` → **121 项全过**（落盘、坏档、容量、字面/语义检索、向量仓、嵌入分批与预算、九个工具、时效与过期、情绪取回、事件、面板、热改、cron、上下文提醒、交接提醒、自动归档、星图布局、查重、静音、导入导出）。不依赖 pnpm，改 store/search/vector/embedding/world/cron/maintenance/dedupe/transfer/starmap-layout 后先跑它。
- 类型检查：`tsc --noEmit`（主项目）与 `tsc -p tsconfig.webui.json --noEmit`（面板）**都通过，0 错误**。
- 单元测试：`vitest run` → **122/122 通过**（`tests/world.test.ts` 34、`tests/dedupe.test.ts` 9、`tests/transfer.test.ts` 6、`tests/starmap-layout.test.ts` 10、`tests/search.test.ts` 16、`tests/cron.test.ts` 12、`tests/embedding.test.ts` 11、`tests/maintenance.test.ts` 15、`tests/vector.test.ts` 6）。
- 面板构建：`dist/webui.js` **约 61.2kb（62,648 B）**，esbuild 无警告。
- **`pnpm` 曾经静默挂住，已修**：`package.json` 里锁的 `packageManager: pnpm@11.28.6` 与本机 12.23.0 不一致，pnpm 10+ 会按字段去取旧版，取不到就无声卡死（`pnpm --version` 正常，因为它不读项目）。改成 `pnpm@12.23.0` 后 `pnpm install` / `pnpm typecheck` / `pnpm test` / `pnpm build:webui` 全部正常，`pnpm-lock.yaml` 已入库。**改这个字段前先看 `pnpm --version`。**
- **不要用 PowerShell 文本管道写文件**：会话里有个防双重编码的插件，`Get-Content x | Set-Content x`、`Out-File`、`cat x > y`、`Tee-Object` 会被直接拒绝执行（看起来像「用户拒绝了命令」），就算跑通也可能把中文按 ANSI 写坏。读用 `read`、写用 `write`/`edit`；脚本里必须读写文件时用 `[IO.File]::ReadAllText` / `[IO.File]::WriteAllText` 配 `[Text.UTF8Encoding]::new($false)`。
- `describe:extension` / `check:extension`：**已用宿主源码跑完第②级**——`node node_modules/tsx/dist/cli.mjs _dev/host-check.ts` 直接调宿主的 `dryMountWorld()` 与 `checkDescribe()`：9 个工具、6 个占位符、4 个面板、2 个配置组全部通过，`describe.json`（9 tools / 15 events / 1 prompt）与代码里的自描述逐字段一致。`check:extension` 本体没跑（它要宿主的依赖，本机没装）。
- `defaults().enabled` 恒为 `false`：宿主 `dryMount` 会拿这条当警告，装不装、开不开由 bot 声明与部署决定。
- 第三级（装进实例目击行为）：未做，待开发者。要看的现象：World 页多四个页签（记忆库 / 星图 / 嵌入 / 数据）、`ink_search` 回执、嵌入页「测试连接」出维度与耗时、星图里点和圈画得出来、数据页导出能下载、覆盖导入要打「替换」。

## 提交前

```bash
pnpm typecheck && pnpm test && pnpm build:webui
```

发布前再跑 `describe:extension` 与 `check:extension`，确认 `describe.json` 与代码同步。
