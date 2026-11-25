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
