import type { Phone, PhoneState } from "./protocol.ts";

export interface PreviewConnection extends Phone {
  close(): void;
}

/** Reopen the transport, then observe. User commands belong to one connection only. */
export class ReconnectingPhone implements Phone {
  generation = 1;
  private current: PreviewConnection | undefined;
  private last: PhoneState;
  private reason: string | undefined;
  private stopped = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void> | undefined;
  private abort = new AbortController();

  constructor(
    initial: PreviewConnection,
    private readonly dial: (signal: AbortSignal) => Promise<PreviewConnection>,
    private readonly timing = { poll: 300, retry: 500, maxRetry: 3000 },
  ) {
    this.current = initial;
    this.last = initial.state;
    this.schedule(timing.poll);
  }

  get state() {
    return this.current?.state ?? this.last;
  }
  get connected() {
    return !this.stopped && this.current?.connected === true;
  }
  get reconnecting() {
    return !this.stopped && !this.connected;
  }
  get disconnectReason() {
    return this.current?.disconnectReason ?? this.reason;
  }

  async request(command: Record<string, unknown>) {
    const connection = this.current;
    if (this.stopped || !connection?.connected) {
      throw Error("Phone disconnected. Waiting for the preview to return.");
    }
    const result = await connection.request(command);
    if (this.current === connection) this.last = result.state;
    return result;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.task = this.tick();
    }, delay);
  }

  private async tick() {
    if (this.stopped) return;
    let delay = this.timing.poll;
    try {
      if (this.current?.connected) {
        await this.request({ method: "get" });
      } else {
        if (this.current) {
          this.last = this.current.state;
          this.reason = this.current.disconnectReason;
          this.current.close();
          this.current = undefined;
        }
        const candidate = await this.dial(this.abort.signal);
        if (this.stopped) {
          candidate.close();
          return;
        }
        this.current = candidate;
        this.last = candidate.state;
        this.reason = undefined;
        this.generation++;
        this.failures = 0;
      }
    } catch {
      delay = Math.min(this.timing.retry * 2 ** Math.min(this.failures++, 4), this.timing.maxRetry);
    } finally {
      this.schedule(delay);
    }
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
    this.current?.close();
    await this.task;
  }
}
