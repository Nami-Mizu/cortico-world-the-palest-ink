/**
 * 每个工具给「人」看的一句话（扩展市场与扩展页用）。
 *
 * 单独放一份、不 import 宿主，是为了让 `_dev/gen-describe.mjs` 能在没有 node_modules
 * 的机器上重建 describe.json。
 */

import type { DescribeText } from 'cortico/core/types.ts';

export const TOOL_SUMMARIES: Readonly<Record<string, DescribeText>> = {
  ink_remember: { zh: '把一件事写进记忆库，返回条目 id。', en: 'Write one memory into the database and return its id.' },
  ink_search: { zh: '按关键词与标签检索记忆，返回带 id 的摘要行。', en: 'Search memories by keywords and tags; returns summary lines with ids.' },
  ink_recall: { zh: '按 id 读一条记忆的全文，并记一次取用。', en: 'Read one memory in full by id and count the recall.' },
  ink_mood: { zh: '按情绪取回几条最相关的记忆，供回复前参考。', en: 'Pull a few memories tagged with one mood, to use before replying.' },
  ink_amend: { zh: '按 id 修订一条记忆的正文、标签或重要度。', en: 'Revise a memory by id: text, tags, kind or importance.' },
  ink_forget: { zh: '按 id 归档一条记忆；配置允许时可真正删除。', en: 'Archive a memory by id; purge it permanently only when config allows.' },
  ink_expired: { zh: '列出已经过期、等着你决定续期还是归档的记忆。', en: 'List memories whose lifetime has run out and that need a decision.' },
  ink_list: { zh: '按时间倒序列出最近的记忆。', en: 'List recent memories, newest first.' },
  ink_stats: { zh: '报告记忆库的规模、种类分布与存档位置。', en: 'Report the database size, kind breakdown and archive path.' },
};
