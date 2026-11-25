/** World 测试共用的假宿主:记录推送的事件与唤醒口径,其余宿主接口都是空实现。 */
import type { EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushDeferred(): void {}
  /** 事件仓足够真：range/latestCursor 按 events 算，上下文估算的用例要靠它。 */
  store = {
    get: (cursor: number): EventEnvelope | undefined => this.events.find((event) => event.cursor === cursor),
    latestCursor: (): number => this.events.length,
    range: (q: { fromCursor?: number; toCursor?: number; limit?: number }): EventEnvelope[] => {
      const from = q.fromCursor ?? 0;
      const to = q.toCursor ?? Number.MAX_SAFE_INTEGER;
      const hits = this.events.filter((event) => event.cursor >= from && event.cursor <= to);
      return q.limit ? hits.slice(-q.limit) : hits;
    },
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐:唤醒/攒批的口径也要能断言 */
  pushOpts: Array<PushOptions | undefined> = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}
