#!/usr/bin/env node
/**
 * 在没有 node_modules 的机器上重建 describe.json。
 *
 * 正式流程是宿主里的 `pnpm describe:extension <包目录>`；这个脚本只是在没装依赖时
 * 按同一份数据（工具声明 + 摘要 + 事件声明 + ENV_PROMPT 原文）生成同样的内容。
 * 生成后仍然建议在宿主里跑一次 describe:extension / check:extension 复核。
 *
 * 用法：node _dev/gen-describe.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INK_EVENT_DECLS } from '../src/events.ts';
import { TOOL_SUMMARIES } from '../src/summaries.ts';
import { INK_TOOL_DECLS } from '../src/world.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

const tools = INK_TOOL_DECLS.map(({ name, description, parameters, tags }) => ({
  name,
  description,
  parameters,
  tags,
  summary: TOOL_SUMMARIES[name],
}));

const events = INK_EVENT_DECLS.map((event) => ({ ...event }));

const content = readFileSync(join(packageDir, 'src', 'ENV_PROMPT.md'), 'utf8');
const prompts = [{ key: 'worlds.thepalestink.envPrompt', title: '淡墨 · 环境提示词', role: 'envPrompt', content }];
const describe = { tools, events, prompts };

writeFileSync(join(packageDir, 'describe.json'), `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
console.log(`Wrote describe.json: tools ${tools.length}, events ${events.length}, prompts ${prompts.length}.`);
