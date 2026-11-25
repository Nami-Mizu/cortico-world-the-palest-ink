/**
 * 淡墨自己的小工具：带偏移的时间戳、条目 id、数值夹取。
 *
 * 刻意不 import 宿主：`_dev/` 下的脚本要能直接 `node src/xxx.ts` 跑，
 * 而宿主的 `cortico/core/util.ts` 在没装依赖的机器上 import 不到。
 */

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  /** 该时刻相对 UTC 的分钟数（东八区为 +480）。 */
  offsetMinutes: number;
}

function zonedParts(timezone: string, at: Date): ZonedParts {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // 配置里写错时区别把整个 World 拖死，退回 UTC。
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // 毫秒不进 Intl，比较前先抹掉，否则偏移会带上小数分钟。
  const offsetMinutes = Math.round((asUtc - (at.getTime() - at.getMilliseconds())) / 60000);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    offsetMinutes,
  };
}

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** 带时区偏移的 ISO 8601（毫秒），形状与宿主的 `nowIso()` 一致。 */
export function nowIso(timezone: string, at: Date = new Date()): string {
  const p = zonedParts(timezone, at);
  const ms = String(at.getMilliseconds()).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${offsetSuffix(p.offsetMinutes)}`;
}

let counter = 0;

/**
 * 一条记忆的 id：`mem_` + 时间戳（36 进制）+ 进程内序号。
 * 同毫秒内连续写入也不会撞 id，重放脚本的结果可比。
 */
export function newId(prefix = 'mem_'): string {
  counter = (counter + 1) % 46656;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(3, '0')}`;
}

/** 整数夹取；非数字或 NaN 时用 fallback。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 合并空白、去首尾。 */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 按字符截断，超长时补省略号。 */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 粗估一段文本占多少 token：中日韩一个字算 1 个，其余 3.6 个字符算 1 个。
 *
 * 只用来判断「上下文是不是快满了」，不需要精确；宁可高估一点，
 * 让提醒早到，也不要等到交接前一秒才说。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3.6);
}
