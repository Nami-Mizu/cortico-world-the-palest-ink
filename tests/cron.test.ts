import { describe, it, expect } from 'vitest';
import { cronMatches, describeCron, nextCronMatch, parseCron, zonedParts } from '../src/cron.ts';

const TZ = 'Asia/Shanghai';

/** 上海本地时间 → Date，省得在用例里算偏移。 */
function shanghai(local: string): Date {
  return new Date(`${local}+08:00`);
}

describe('cron 解析', () => {
  it('解析五段并保留原文', () => {
    const spec = parseCron('30 7 * * *');
    expect(spec.source).toBe('30 7 * * *');
    expect([...spec.minutes]).toEqual([30]);
    expect([...spec.hours]).toEqual([7]);
    expect(spec.dayOfMonthRestricted).toBe(false);
    expect(spec.dayOfWeekRestricted).toBe(false);
  });

  it('支持 *、?、区间、列表与步长', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('1-5/2 * * * *').minutes]).toEqual([1, 3, 5]);
    expect([...parseCron('10,20,30 * * * *').minutes]).toEqual([10, 20, 30]);
    expect([...parseCron('0 9-17/4 * * *').hours]).toEqual([9, 13, 17]);
    expect([...parseCron('0 0 * * ?').daysOfWeek]).toHaveLength(7);
  });

  it('周日的 7 折成 0', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('不合法时抛出中文错误', () => {
    expect(() => parseCron('')).toThrow('空的');
    expect(() => parseCron('30 7 * *')).toThrow('五段');
    expect(() => parseCron('60 * * * *')).toThrow('0–59');
    expect(() => parseCron('0 24 * * *')).toThrow('0–23');
    expect(() => parseCron('x * * * *')).toThrow();
  });
});

describe('cron 匹配', () => {
  it('每天 07:30 只在那分钟命中', () => {
    const spec = parseCron('30 7 * * *');
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-25T07:30:00'), TZ))).toBe(true);
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-25T07:31:00'), TZ))).toBe(false);
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-25T19:30:00'), TZ))).toBe(false);
  });

  it('工作日 09:00 只在周一到周五命中', () => {
    const spec = parseCron('0 9 * * 1-5');
    // 2026-11-25 是周三
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-25T09:00:00'), TZ))).toBe(true);
    // 2026-11-29 是周日
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-29T09:00:00'), TZ))).toBe(false);
  });

  it('日与周同时限定时满足其一即可', () => {
    const spec = parseCron('0 12 13 * 5');
    // 13 号但不是周五
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-13T12:00:00'), TZ))).toBe(true);
    // 周五但不是 13 号
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-27T12:00:00'), TZ))).toBe(true);
    // 普通的一天
    expect(cronMatches(spec, zonedParts(shanghai('2026-11-25T12:00:00'), TZ))).toBe(false);
  });

  it('月份限制生效', () => {
    const spec = parseCron('0 0 1 1 *');
    expect(cronMatches(spec, zonedParts(shanghai('2027-01-01T00:00:00'), TZ))).toBe(true);
    expect(cronMatches(spec, zonedParts(shanghai('2027-02-01T00:00:00'), TZ))).toBe(false);
  });
});

describe('cron 下次时间与描述', () => {
  it('下一分钟就是下一次', () => {
    const spec = parseCron('* * * * *');
    const next = nextCronMatch(spec, shanghai('2026-11-25T23:30:20'), TZ);
    expect(next?.toISOString()).toBe(shanghai('2026-11-25T23:31:00').toISOString());
  });

  it('今天过了就落到明天', () => {
    const spec = parseCron('30 7 * * *');
    const next = nextCronMatch(spec, shanghai('2026-11-25T08:00:00'), TZ);
    expect(next?.toISOString()).toBe(shanghai('2026-11-26T07:30:00').toISOString());
  });

  it('严格在未来：正好命中时取下一次', () => {
    const spec = parseCron('30 7 * * *');
    const next = nextCronMatch(spec, shanghai('2026-11-25T07:30:00'), TZ);
    expect(next?.toISOString()).toBe(shanghai('2026-11-26T07:30:00').toISOString());
  });

  it('描述成人话', () => {
    expect(describeCron(parseCron('30 7 * * *'))).toContain('每天');
    expect(describeCron(parseCron('30 7 * * *'))).toContain('07:30');
    expect(describeCron(parseCron('0 9 * * 1-5'))).toContain('周一');
    expect(describeCron(parseCron('0 9 * * 1-5'))).toContain('09:00');
    expect(describeCron(parseCron('0 0 1 * *'))).toContain('1 日');
    expect(describeCron(parseCron('* * * * *'))).toContain('每分钟');
  });
});
