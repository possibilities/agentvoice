import { MAX_THREADS, type ThreadInventory, type ThreadView } from "../events/contract.ts";

type Request = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const idOf = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : undefined;
function nativeStatus(value: unknown): Pick<ThreadView, "status" | "activeFlags"> {
  const status = record(value);
  const kind = status["type"];
  return {
    status:
      kind === "active" || kind === "idle" || kind === "notLoaded" || kind === "systemError"
        ? kind
        : "unknown",
    activeFlags: Array.isArray(status["activeFlags"])
      ? [
          ...new Set(
            status["activeFlags"].filter(
              (flag): flag is "waitingOnApproval" | "waitingOnUserInput" =>
                flag === "waitingOnApproval" || flag === "waitingOnUserInput",
            ),
          ),
        ]
      : [],
  };
}

/** Observe only the owned child's live inventory. Reads never resume threads or load turns. */
export class ThreadObserver {
  private readonly threads = new Map<string, ThreadView>();
  private readonly pending = new Set<string>();
  private readonly renamed = new Set<string>();
  private readonly seenDuringScan = new Set<string>();
  private started = false;
  private stopped = false;
  private scanning = true;
  private complete = false;
  private overflow = false;
  private reading = false;
  constructor(
    private readonly request: Request,
    private readonly publish: (inventory: ThreadInventory) => void,
  ) {}

  seed(value: unknown): void {
    const raw = record(value);
    const id = idOf(raw["id"]);
    if (!id) return;
    const prior = this.threads.get(id);
    const thread = this.ensure(id);
    if (!thread) return;
    const name = raw["name"];
    this.threads.set(id, {
      ...thread,
      parentThreadId: idOf(raw["parentThreadId"]) ?? thread.parentThreadId,
      name: this.renamed.has(id)
        ? thread.name
        : typeof name === "string"
          ? name.slice(0, 256)
          : thread.name,
      ...(prior && prior.status !== "unknown" ? {} : nativeStatus(raw["status"])),
    });
    this.emit();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let count = 0;
      do {
        const page = record(
          await this.request(
            "thread/loaded/list",
            { limit: 100, ...(cursor ? { cursor } : {}) },
            2_000,
          ),
        );
        if (this.stopped) return;
        if (!Array.isArray(page["data"])) throw new Error("invalid loaded inventory");
        for (const rawId of page["data"]) {
          const id = idOf(rawId);
          if (!id || ++count > MAX_THREADS) throw new Error("loaded inventory limit");
          if (!this.seenDuringScan.has(id) && this.ensure(id)) this.pending.add(id);
        }
        const next = page["nextCursor"];
        if (next !== undefined && next !== null && typeof next !== "string")
          throw new Error("invalid cursor");
        cursor = typeof next === "string" && next ? next : undefined;
        if (cursor && cursors.has(cursor)) throw new Error("repeated cursor");
        if (cursor) cursors.add(cursor);
        if (cursors.size > MAX_THREADS) throw new Error("inventory page limit");
      } while (cursor);
      this.complete = !this.overflow;
    } catch {
      this.complete = false;
    } finally {
      this.scanning = false;
      this.seenDuringScan.clear();
      this.emit();
      void this.readPending();
    }
  }

  notification(method: string, params: Record<string, unknown>): void {
    if (this.stopped) return;
    if (method === "thread/started") {
      this.seed(params["thread"]);
      return;
    }
    if (
      ![
        "thread/status/changed",
        "thread/closed",
        "thread/name/updated",
        "turn/started",
        "turn/completed",
      ].includes(method)
    )
      return;
    const id = idOf(params["threadId"]);
    if (!id) return;
    if (this.scanning) {
      if (this.seenDuringScan.size < MAX_THREADS) this.seenDuringScan.add(id);
      else if (!this.seenDuringScan.has(id)) this.overflow = true;
    }
    if (
      method === "thread/closed" ||
      (method === "thread/status/changed" && record(params["status"])["type"] === "notLoaded")
    ) {
      this.threads.delete(id);
      this.renamed.delete(id);
      this.pending.delete(id);
      this.emit();
      return;
    }
    const existed = this.threads.has(id);
    if (method === "thread/name/updated" && !existed) return;
    const thread = this.ensure(id);
    if (!thread) return;
    const next = { ...thread };
    if (method === "thread/status/changed") Object.assign(next, nativeStatus(params["status"]));
    if (method === "thread/name/updated") {
      const name = params["threadName"];
      if (typeof name === "string" || name === null) {
        next.name = typeof name === "string" ? name.slice(0, 256) : null;
        this.renamed.add(id);
      }
    }
    if (method.startsWith("turn/")) {
      const turn = record(params["turn"]);
      const turnId = idOf(turn["id"]);
      const status = turn["status"];
      if (
        turnId &&
        (status === "inProgress" ||
          status === "completed" ||
          status === "failed" ||
          status === "interrupted")
      )
        next.turn = { id: turnId, status };
    }
    this.threads.set(id, next);
    if (!existed) this.pending.add(id);
    this.emit();
    if (this.started && !this.scanning) void this.readPending();
  }
  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }
  private ensure(id: string): ThreadView | undefined {
    if (this.stopped) return;
    const existing = this.threads.get(id);
    if (existing) return existing;
    if (this.threads.size >= MAX_THREADS) {
      this.overflow = true;
      this.complete = false;
      this.emit();
      return;
    }
    const thread: ThreadView = {
      id,
      name: null,
      parentThreadId: null,
      status: "unknown",
      activeFlags: [],
      turn: null,
    };
    this.threads.set(id, thread);
    return thread;
  }
  private async readPending(): Promise<void> {
    if (this.reading || this.stopped) return;
    this.reading = true;
    try {
      for (const id of this.pending) {
        this.pending.delete(id);
        const before = this.threads.get(id);
        if (!before) continue;
        try {
          const result = record(
            await this.request("thread/read", { threadId: id, includeTurns: false }, 2_000),
          );
          if (this.stopped) return;
          const raw = record(result["thread"]);
          if (raw["id"] !== id) throw new Error("thread read identity mismatch");
          const current = this.threads.get(id);
          if (!current) continue;
          if (current === before && record(raw["status"])["type"] === "notLoaded") {
            this.threads.delete(id);
            this.renamed.delete(id);
            this.emit();
            continue;
          }
          // Reads may finish after notifications. Fill metadata, but never rewind newer state.
          const name = raw["name"];
          this.threads.set(id, {
            ...current,
            name: this.renamed.has(id)
              ? current.name
              : (current.name ?? (typeof name === "string" ? name.slice(0, 256) : null)),
            parentThreadId: current.parentThreadId ?? idOf(raw["parentThreadId"]) ?? null,
            ...(current === before ? nativeStatus(raw["status"]) : {}),
          });
        } catch {
          this.complete = false;
        }
        this.emit();
      }
    } finally {
      this.reading = false;
      this.emit();
    }
  }
  private emit(): void {
    if (!this.stopped)
      this.publish({
        threads: [...this.threads.values()],
        complete: this.complete && !this.scanning && this.pending.size === 0 && !this.reading,
      });
  }
}
