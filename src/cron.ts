/**
 * 五行 cron（分 时 日 月 周）的解析、匹配与描述。
 *
 * 只做本 World 需要的那点事：判断「此刻是否到点」，以及给人看一句「下次什么时候」。
 * 不实现秒级、不实现 `@daily` 这类别名，也不处理夏令时——部署时区按 `ctx.timezone`，
 * 本地时间在切换那小时里可能重复或跳过，提醒最多晚一次或早一次，不影响正确性。
 *
 * 语法：`*`、`?`（等同 `*`）、数字、`a-b`、`a,b`、以及它们与斜杠步长的组合（如星号加 `/15`、`1-5/2`、`10/20`）。
 * 日与周同时被限定时按 cron 的老规矩「满足其一即可」。
 */

export interface CronSpec {
  /** 参与错误提示与面板展示的原文。 */
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** 该字段不是 `*`/`?`：日与周都用它判断「同时限定」。 */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

/** 目标时区里的日历读数；weekday 0 = 周日。 */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 解析五段 cron；不合法时抛出中文错误。 */
export function parseCron(expr: string): CronSpec {
  const source = collapseSpaces(expr);
  if (!source) throw new Error('cron 表达式是空的；写 `30 7 * * *` 这样五段，或留空表示不提醒。');
  const parts = source.split(' ');
  if (parts.length !== 5) {
    throw new Error(`cron 表达式要五段（分 时 日 月 周），现在是 ${parts.length} 段：「${source}」。`);
  }
  const minutes = parseField(parts[0]!, 0, 59, '分', source);
  const hours = parseField(parts[1]!, 0, 23, '时', source);
  const daysOfMonth = parseField(parts[2]!, 1, 31, '日', source);
  const months = parseField(parts[3]!, 1, 12, '月', source);
  const daysOfWeek = parseField(parts[4]!, 0, 7, '周', source);
  // cron 允许 7 表示周日，统一折成 0。
  if (daysOfWeek.values.has(7)) {
    daysOfWeek.values.delete(7);
    daysOfWeek.values.add(0);
  }
  return {
    source,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    dayOfMonthRestricted: daysOfMonth.restricted,
    dayOfWeekRestricted: daysOfWeek.restricted,
  };
}

/** 解析单个字段；`restricted` 只在原文是 `*` 或 `?` 时为 false。 */
function parseField(text: string, min: number, max: number, label: string, source: string): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const trimmed = text.trim();
  if (trimmed === '*' || trimmed === '?') {
    for (let value = min; value <= max; value += 1) values.add(value);
    return { values, restricted: false };
  }
  for (const piece of trimmed.split(',')) {
    const [rangeText, stepText, extra] = piece.split('/');
    if (extra !== undefined) throw new Error(`cron 的「${label}」段看不懂：「${piece}」。`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 的「${label}」段步长要是正整数：「${piece}」。`);
    let from: number;
    let to: number;
    if (rangeText === '*' || rangeText === '?') {
      from = min;
      to = max;
    } else if (rangeText !== undefined && rangeText.includes('-')) {
      const [left, right] = rangeText.split('-');
      from = Number(left);
      to = Number(right);
    } else {
      from = Number(rangeText);
      // `10/20` 的意思是「从 10 开始，每 20 一格」。
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`cron 的「${label}」段超出范围（${min}–${max}）：「${piece}」（完整表达式「${source}」）。`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`cron 的「${label}」段没有可用的值：「${text}」。`);
  return { values, restricted: true };
}

/** 按目标时区的日历读数判断是否命中。 */
export function cronMatches(spec: CronSpec, parts: ZonedParts): boolean {
  if (!spec.minutes.has(parts.minute)) return false;
  if (!spec.hours.has(parts.hour)) return false;
  if (!spec.months.has(parts.month)) return false;
  const dayHit = spec.daysOfMonth.has(parts.day);
  const weekHit = spec.daysOfWeek.has(parts.weekday);
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return dayHit || weekHit;
  if (spec.dayOfMonthRestricted) return dayHit;
  if (spec.dayOfWeekRestricted) return weekHit;
  return true;
}

/** 把某个时刻换算成目标时区的读数。 */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const bag: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  // 用 UTC 重建那一天只为取星期，不参与时区换算。
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // h23 在个别 ICU 版本里仍给 "24"，归一到 0。
  const hour = Number(bag.hour) % 24;
  return { year, month, day, hour, minute: Number(bag.minute), weekday };
}

/**
 * 从 `from` 之后（不含当分钟）找下一次命中的时刻，最多找 `maxDays` 天。
 * 找不到返回 null。
 */
export function nextCronMatch(spec: CronSpec, from: Date, timeZone: string, maxDays = 370): Date | null {
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = maxDays * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    const at = new Date(start.getTime() + step * 60_000);
    if (cronMatches(spec, zonedParts(at, timeZone))) return at;
  }
  return null;
}

/** 给人看的一句话，例如「每天 07:30」「每周一至周五 09:00」「每月 1 日 10:00」。 */
export function describeCron(spec: CronSpec): string {
  const allMonths = spec.months.size === 12;
  const allDays = spec.daysOfMonth.size === 31;
  const allWeeks = spec.daysOfWeek.size === 7;
  const hour = single(spec.hours);
  const minute = single(spec.minutes);
  const clock = hour !== null && minute !== null ? `${pad(hour)}:${pad(minute)}` : null;
  if (allMonths && allDays && allWeeks) {
    if (clock) return `每天 ${clock}`;
    if (minute !== null) return `每小时的 ${pad(minute)} 分`;
    if (hour !== null) return `每天 ${pad(hour)} 点的每分钟`;
    return '每分钟';
  }
  const bits: string[] = [];
  if (!allMonths) bits.push(`每月 ${[...spec.months].sort(ascending).join('、')} 月`);
  if (!allDays) bits.push(`${[...spec.daysOfMonth].sort(ascending).join('、')} 日`);
  if (!allWeeks) bits.push([...spec.daysOfWeek].sort(ascending).map((day) => WEEKDAY_NAMES[day] ?? `周${day}`).join('、'));
  if (clock) bits.push(clock);
  else bits.push(`${[...spec.hours].sort(ascending).map(pad).join('、')}:${minute === null ? '每分' : pad(minute)}`);
  return bits.join(' ');
}

const pad = (value: number): string => String(value).padStart(2, '0');
const ascending = (a: number, b: number): number => a - b;
const single = (values: ReadonlySet<number>): number | null => (values.size === 1 ? [...values][0]! : null);
const collapseSpaces = (text: string): string => text.trim().split(/\s+/).filter(Boolean).join(' ');
