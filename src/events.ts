export type EventSource =
  | "harness"
  | "app-server"
  | "bridge"
  | "realtime"
  | "livekit"
  | "fx"
  | "media"
  | "oracle";

export interface EventRecord {
  seq: number;
  atMs: number;
  source: EventSource;
  type: string;
  data: Record<string, unknown>;
}

interface EventWaiter {
  type: string;
  occurrence?: number;
  afterSeq?: number;
  resolve(event: EventRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One append-only clock for media, App-server, and scenario events. Waiting by
 * occurrence makes scripts race-free: a fast event still satisfies a wait
 * registered after it arrived.
 */
export class EventJournal {
  private readonly startedAt = performance.now();
  private readonly entries: EventRecord[] = [];
  private readonly waiters = new Set<EventWaiter>();

  record(source: EventSource, type: string, data: Record<string, unknown> = {}): EventRecord {
    const event: EventRecord = {
      seq: this.entries.length + 1,
      atMs: performance.now() - this.startedAt,
      source,
      type,
      data,
    };
    this.entries.push(event);
    this.settleWaiters();
    return event;
  }

  snapshot(): readonly EventRecord[] {
    return this.entries;
  }

  count(type: string): number {
    return this.entries.reduce((count, event) => count + Number(event.type === type), 0);
  }

  waitFor(type: string, occurrence: number, timeoutMs: number): Promise<EventRecord> {
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      return Promise.reject(
        new Error(`event occurrence must be a positive integer; got ${occurrence}`),
      );
    }
    const existing = this.occurrence(type, occurrence);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        type,
        occurrence,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `no ${type} occurrence ${occurrence} within ${timeoutMs}ms ` +
                `(observed ${this.count(type)})`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  waitForNext(type: string, afterSeq: number, timeoutMs: number): Promise<EventRecord> {
    const existing = this.next(type, afterSeq);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        type,
        afterSeq,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`no ${type} after event ${afterSeq} within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(reason = "event journal closed"): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.waiters.clear();
  }

  private occurrence(type: string, occurrence: number): EventRecord | undefined {
    let seen = 0;
    for (const event of this.entries) {
      if (event.type !== type) continue;
      seen++;
      if (seen === occurrence) return event;
    }
    return undefined;
  }

  private next(type: string, afterSeq: number): EventRecord | undefined {
    return this.entries.find((event) => event.seq > afterSeq && event.type === type);
  }

  private settleWaiters(): void {
    for (const waiter of this.waiters) {
      const event =
        waiter.occurrence !== undefined
          ? this.occurrence(waiter.type, waiter.occurrence)
          : this.next(waiter.type, waiter.afterSeq ?? 0);
      if (!event) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
}
