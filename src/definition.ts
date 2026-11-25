/**
 * 淡墨 · 记忆库的 World 定义（宿主加载的入口在这里 re-export）。
 */

import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { INK_DEFAULTS, type InkConfigSection } from './config.ts';
import { INK_EVENT_DECLS } from './events.ts';
import { TOOL_SUMMARIES } from './summaries.ts';
import { INK_LABEL, INK_TOOL_DECLS, INK_WORLD_ID, ThePalestInkWorld } from './world.ts';

export const THE_PALEST_INK: WorldDefinition<InkConfigSection> = {
  id: INK_WORLD_ID,
  label: INK_LABEL,
  defaults: () => ({ ...INK_DEFAULTS }),
  create: (ctx) =>
    new ThePalestInkWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      secret: (name) => ctx.secret(name),
      storeSecret: (name, value) => ctx.storeSecret(name, value),
      persist: (patch) => ctx.persist(patch as Partial<InkConfigSection>),
    }),
  describe: {
    tools: describeTools(INK_TOOL_DECLS, TOOL_SUMMARIES),
    events: INK_EVENT_DECLS,
  },
};
