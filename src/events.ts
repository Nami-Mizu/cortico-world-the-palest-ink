/**
 * 事件声明与推送用的类型。
 *
 * 事件类型段（点号之间）只用小写字母与数字，避免 `ink.memory.added` 这类名字被校验拒收。
 * 事件正文一律是「给人看的短句」：模型看到的事件应该能直接读懂刚才发生了什么。
 */

import type { EventDescribe } from 'cortico/core/types.ts';

export const INK_EVENTS = {
  loaded: 'ink.memory.loaded',
  added: 'ink.memory.added',
  amended: 'ink.memory.amended',
  archived: 'ink.memory.archived',
  purged: 'ink.memory.purged',
  recalled: 'ink.memory.recalled',
  evicted: 'ink.memory.evicted',
  swept: 'ink.maintenance.swept',
  recovered: 'ink.store.recovered',
  embedReady: 'ink.embed.ready',
  embedFailed: 'ink.embed.failed',
  reindexed: 'ink.embed.reindexed',
  scheduleReminder: 'ink.reminder.schedule',
  contextReminder: 'ink.reminder.context',
  handoffReminder: 'ink.reminder.handoff',
} as const;

export type InkEventType = (typeof INK_EVENTS)[keyof typeof INK_EVENTS];

export const INK_EVENT_DECLS: readonly EventDescribe[] = [
  {
    type: INK_EVENTS.loaded,
    description: { zh: '记忆库载入完成，报告条目数与置顶数。', en: 'The memory database finished loading and reports its size.' },
    trigger: 'preempt',
  },
  {
    type: INK_EVENTS.added,
    description: { zh: '写进了一条新记忆，带上 id、种类与标签。', en: 'A new memory was written, with id, kind and tags.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.amended,
    description: { zh: '一条已有记忆被修订。', en: 'An existing memory was revised.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.archived,
    description: { zh: '一条记忆被归档（不再参与默认检索，仍在存档里）。', en: 'A memory was archived: out of default search, still on disk.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.purged,
    description: { zh: '一条记忆被物理删除，不可恢复。', en: 'A memory was permanently deleted.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.recalled,
    description: { zh: '一条记忆被取用（ink_recall 读全文）。', en: 'A memory was recalled in full.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.evicted,
    description: { zh: '容量到顶，最久没被取用的条目被挤进归档。', en: 'Capacity reached; the least recently used entries were pushed into the archive.' },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.swept,
    description: {
      zh: '一轮自动整理结束：报归档了几条（久未取用 / 内容重复各几条）与最多五条样本，不逐条发。',
      en: 'One automatic sweep finished: reports how many were archived (stale / duplicate), with up to five samples, instead of one event per entry.',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.recovered,
    description: { zh: '存档损坏，已改名备份并从空库继续。', en: 'The archive was unreadable; it was renamed aside and the database started empty.' },
    trigger: 'preempt',
  },
  {
    type: INK_EVENTS.embedReady,
    description: {
      zh: '嵌入模型连上了，语义检索可用（报模型与维度）。',
      en: 'The embedding model answered; semantic search is available (reports model and dimensions).',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.embedFailed,
    description: {
      zh: '嵌入调用失败，检索已退回字面匹配（报一句原因）。',
      en: 'The embedding call failed; search fell back to literal matching (reports the reason).',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.reindexed,
    description: {
      zh: '向量重建完成（报补了几条、失败几条）。',
      en: 'Vector backfill finished (reports how many were indexed and how many failed).',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.scheduleReminder,
    description: {
      zh: '到了配置的钟点，提醒模型回顾这段时间、把值得留下的写进记忆库。',
      en: 'The configured cron time arrived; the model is reminded to write down what is worth keeping.',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.contextReminder,
    description: {
      zh: '估算的上下文用量越过阈值，提醒模型趁细节还在、先写记忆。',
      en: 'Estimated context usage crossed the threshold; the model is reminded to write memories while details are fresh.',
    },
    trigger: 'flush',
  },
  {
    type: INK_EVENTS.handoffReminder,
    description: {
      zh: '上下文刚完成交接，提醒模型补写交接中可能丢掉、但之后会用到的细节。',
      en: 'Context handoff just finished; the model is reminded to write details that may have been lost.',
    },
    trigger: 'preempt',
  },
];
