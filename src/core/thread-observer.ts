import { MAX_THREADS, type ThreadInventory, type ThreadView } from "../events/contract.ts";

type Request = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
const SCAN_PAGE_SIZE = 100;
const MAX_SCAN_IDS = 4_096;
const MAX_SCAN_PAGES = 64;
const SCAN_TIMEOUT_MS = 15_000;
const READ_CONCURRENCY = 4;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

type ObserverOptions = {
  retryMinMs?: number;
  retryMaxMs?: number;
};

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

function nativeTimestamp(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function nativeTurn(value: unknown): ThreadView["turn"] | undefined {
  const turn = record(value);
  const id = idOf(turn["id"]);
  const status = turn["status"];
  if (
    !id ||
    !["inProgress", "completed", "failed", "interrupted"].includes(
      typeof status === "string" ? status : "",
    )
  )
    return;
  const startedAt = nativeTimestamp(turn["startedAt"]);
  const completedAt = status === "inProgress" ? undefined : nativeTimestamp(turn["completedAt"]);
  return {
    id,
    status: status as NonNullable<ThreadView["turn"]>["status"],
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function mergeTurn(current: ThreadView["turn"], evidence: ThreadView["turn"]): ThreadView["turn"] {
  if (!current) return evidence;
  if (!evidence || current.id !== evidence.id) return current;
  const startedAt = current.startedAt ?? evidence.startedAt;
  const completedAt =
    current.status === "inProgress" ? undefined : (current.completedAt ?? evidence.completedAt);
  return {
    id: current.id,
    status: current.status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function threadFromRead(value: unknown, expectedId: string): ThreadView {
  const raw = record(record(value)["thread"]);
  if (raw["id"] !== expectedId) throw new Error("thread read identity mismatch");
  const name = raw["name"];
  return {
    id: expectedId,
    parentThreadId: idOf(raw["parentThreadId"]) ?? null,
    name: typeof name === "string" ? name.slice(0, 256) : null,
    ...nativeStatus(raw["status"]),
    turn: null,
  };
}

/** Observe only the owned child's live inventory. Reads never resume threads or load turn items. */
export class ThreadObserver {
  private readonly threads = new Map<string, ThreadView>();
  private readonly pending = new Set<string>();
  private readonly renamed = new Set<string>();
  private readonly changedDuringScan = new Set<string>();
  private readonly removedDuringScan = new Set<string>();
  private started = false;
  private stopped = false;
  private scanning = false;
  private complete = false;
  private overflow = false;
  private reading = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly request: Request,
    private readonly publish: (inventory: ThreadInventory) => void,
    private readonly options: ObserverOptions = {},
  ) {}

  seed(value: unknown): string | undefined {
    const raw = record(value);
    const id = idOf(raw["id"]);
    if (!id) return;
    const prior = this.threads.get(id);
    const thread = this.ensure(id);
    if (!thread) return id;
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
    return id;
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.reconcile(false);
  }

  notification(method: string, params: Record<string, unknown>): void {
    if (this.stopped) return;
    if (method === "thread/started") {
      const id = this.seed(params["thread"]);
      if (!id) return;
      if (this.scanning) this.changedDuringScan.add(id);
      if (this.threads.has(id)) this.pending.add(id);
      else this.scheduleRetry();
      this.emit();
      void this.readPending();
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
    if (this.scanning) this.changedDuringScan.add(id);
    if (
      method === "thread/closed" ||
      (method === "thread/status/changed" && record(params["status"])["type"] === "notLoaded")
    ) {
      if (this.scanning) this.removedDuringScan.add(id);
      this.threads.delete(id);
      this.renamed.delete(id);
      this.pending.delete(id);
      this.emit();
      if (this.overflow) this.scheduleRetry();
      return;
    }
    const existed = this.threads.has(id);
    if (method === "thread/name/updated" && !existed && !this.scanning) return;
    const thread = this.ensure(id);
    if (!thread) {
      this.scheduleRetry();
      return;
    }
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
      const turn = nativeTurn(params["turn"]);
      if (turn) next.turn = mergeTurn(turn, next.turn);
    }
    this.threads.set(id, next);
    if (!existed) this.pending.add(id);
    this.emit();
    if (this.started && !this.scanning) void this.readPending();
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async reconcile(waitForReads = true): Promise<void> {
    if (this.scanning || this.stopped) return;
    if (this.reading) {
      this.scheduleRetry();
      return;
    }
    this.scanning = true;
    this.changedDuringScan.clear();
    this.removedDuringScan.clear();
    this.emit();
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    let ids: string[];
    try {
      ids = await this.scanIds(deadline);
    } catch {
      this.finishReconciliation(false);
      return;
    }
    const finishing = this.readAndApply(ids, deadline);
    if (waitForReads) await finishing;
  }

  private async readAndApply(ids: string[], deadline: number): Promise<void> {
    let successful = false;
    try {
      const { observed, failed } = await this.readIds(ids, deadline);
      if (this.stopped) return;
      const next = new Map<string, ThreadView>();
      for (const [id, current] of this.threads) {
        if (this.changedDuringScan.has(id)) next.set(id, current);
      }
      for (const id of ids) {
        const thread = observed.get(id);
        if (!thread) continue;
        if (thread.status !== "unknown") this.pending.delete(id);
        const current = this.threads.get(id);
        if (this.changedDuringScan.has(id)) {
          if (current)
            next.set(id, {
              ...current,
              name: this.renamed.has(id) ? current.name : (current.name ?? thread.name),
              parentThreadId: current.parentThreadId ?? thread.parentThreadId,
            });
          continue;
        }
        next.set(id, {
          ...thread,
          name: this.renamed.has(id) ? (current?.name ?? thread.name) : thread.name,
          turn: mergeTurn(current?.turn ?? null, thread.turn),
        });
      }
      const rows = [...next.values()];
      this.overflow = rows.length > MAX_THREADS;
      this.threads.clear();
      for (const thread of rows.slice(0, MAX_THREADS)) this.threads.set(thread.id, thread);
      this.complete = !this.overflow && !failed;
      successful = !failed;
    } catch {
      this.complete = false;
    } finally {
      this.finishReconciliation(successful);
    }
  }

  private finishReconciliation(successful: boolean): void {
    this.scanning = false;
    this.changedDuringScan.clear();
    this.removedDuringScan.clear();
    if (successful && !this.overflow) this.retryAttempt = 0;
    this.emit();
    void this.readPending();
    if (!successful || this.overflow) this.scheduleRetry();
  }

  private async scanIds(deadline: number): Promise<string[]> {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (Date.now() >= deadline || ++pages > MAX_SCAN_PAGES)
        throw new Error("inventory scan limit");
      const page = record(
        await this.request(
          "thread/loaded/list",
          { limit: SCAN_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          Math.min(2_000, Math.max(1, deadline - Date.now())),
        ),
      );
      if (this.stopped) return [];
      if (!Array.isArray(page["data"])) throw new Error("invalid loaded inventory");
      if (page["data"].length > SCAN_PAGE_SIZE) throw new Error("oversized inventory page");
      for (const rawId of page["data"]) {
        const id = idOf(rawId);
        if (!id) throw new Error("invalid loaded inventory");
        ids.add(id);
        if (ids.size > MAX_SCAN_IDS) throw new Error("loaded inventory safety limit");
      }
      const next = page["nextCursor"];
      if (next !== undefined && next !== null && typeof next !== "string")
        throw new Error("invalid cursor");
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...ids];
  }

  private async readIds(
    ids: string[],
    deadline: number,
  ): Promise<{ observed: Map<string, ThreadView>; failed: boolean }> {
    const observed = new Map<string, ThreadView>();
    let next = 0;
    let failed = false;
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, async () => {
        while (!this.stopped) {
          const id = ids[next++];
          if (!id) return;
          if (this.removedDuringScan.has(id)) continue;
          observed.set(id, {
            id,
            name: null,
            parentThreadId: null,
            status: "unknown",
            activeFlags: [],
            turn: null,
          });
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            failed = true;
            continue;
          }
          try {
            const thread = threadFromRead(
              await this.request(
                "thread/read",
                { threadId: id, includeTurns: false },
                Math.min(2_000, remaining),
              ),
              id,
            );
            const turnRemaining = deadline - Date.now();
            if (turnRemaining > 0) {
              try {
                thread.turn =
                  (await this.readLatestTurn(id, Math.min(2_000, turnRemaining))) ?? null;
              } catch {
                // Older or partial native runtimes may not expose turn history.
              }
            }
            if (thread.status === "notLoaded") observed.delete(id);
            else observed.set(id, thread);
          } catch {
            failed = true;
          }
        }
      }),
    );
    return { observed, failed };
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
    if (this.reading || this.stopped || this.scanning) return;
    this.reading = true;
    try {
      for (const id of this.pending) {
        this.pending.delete(id);
        const before = this.threads.get(id);
        if (!before) continue;
        try {
          const read = threadFromRead(
            await this.request("thread/read", { threadId: id, includeTurns: false }, 2_000),
            id,
          );
          try {
            read.turn = (await this.readLatestTurn(id, 2_000)) ?? null;
          } catch {
            // Older or partial native runtimes may not expose turn history.
          }
          if (this.stopped) return;
          const current = this.threads.get(id);
          if (!current) continue;
          if (current === before && read.status === "notLoaded") {
            this.threads.delete(id);
            this.renamed.delete(id);
            this.emit();
            continue;
          }
          // Reads may finish after notifications. Fill metadata, but never rewind newer state.
          this.threads.set(id, {
            ...current,
            name: this.renamed.has(id) ? current.name : (current.name ?? read.name),
            parentThreadId: current.parentThreadId ?? read.parentThreadId,
            turn: mergeTurn(current.turn, read.turn),
            ...(current === before ? { status: read.status, activeFlags: read.activeFlags } : {}),
          });
        } catch {
          this.complete = false;
          this.scheduleRetry();
        }
        this.emit();
      }
    } finally {
      this.reading = false;
      this.emit();
    }
  }

  private async readLatestTurn(id: string, timeout: number): Promise<ThreadView["turn"]> {
    const page = record(
      await this.request(
        "thread/turns/list",
        { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
        timeout,
      ),
    );
    const rows = page["data"];
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("invalid turn metadata page");
    if (rows.length === 0) return null;
    const turn = nativeTurn(rows[0]);
    if (!turn) throw new Error("invalid turn metadata");
    return turn;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const minimum = Math.max(0, this.options.retryMinMs ?? RETRY_MIN_MS);
    const maximum = Math.max(minimum, this.options.retryMaxMs ?? RETRY_MAX_MS);
    const delay = Math.min(maximum, minimum * 2 ** Math.min(this.retryAttempt++, 8));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconcile();
    }, delay);
  }

  private emit(): void {
    if (!this.stopped)
      this.publish({
        threads: [...this.threads.values()],
        complete:
          this.complete &&
          !this.overflow &&
          !this.scanning &&
          this.pending.size === 0 &&
          !this.reading,
      });
  }
}
