import { CONTROL_MCP_SERVER_NAME } from "../control/types.ts";
import {
  type Child,
  type Completion,
  childSchema,
  type InFlight,
  MAILBOX_NAMESPACE,
  MAILBOX_OUTPUT,
  MAILBOX_TOOL,
  type MailboxCaller,
  type MailboxObservation,
  mailboxId,
  wakeNoticeSchema,
} from "./contract.ts";

type Request = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
const row = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const id = (v: unknown): string | null => {
  const p = mailboxId.safeParse(v);
  return p.success ? p.data : null;
};
type TurnEvent =
  | { kind: "started"; turnId: string; observedAt: string }
  | { kind: "completed"; turnId: string; status: Completion["status"]; observedAt: string };
type Tracked = {
  child: Child;
  verified: boolean | null;
  revision: number;
  active: boolean;
  pending: TurnEvent[];
  seen: Set<string>;
};

/** Native facts only: no thread resume, history hydration, or inference for observation. */
export class SubagentObserver {
  private readonly threads = new Map<string, Tracked>();
  private readonly reads = new Set<string>();
  private readonly calls = new Set<string>();
  private readonly callWaiters = new Set<() => void>();
  private stopped = false;
  private reading = false;
  private scanning = true;
  private complete = true;
  private lastInventory = "";
  private revision = 0;
  constructor(
    private readonly root: string,
    private readonly workspace: string,
    private readonly request: Request,
    private readonly publish: (event: MailboxObservation) => void,
    private readonly secrets: readonly string[] = [],
  ) {}
  async start() {
    try {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = row(
          await this.request(
            "thread/loaded/list",
            { limit: 100, ...(cursor ? { cursor } : {}) },
            2000,
          ),
        );
        if (this.stopped) return;
        if (!Array.isArray(page["data"])) throw new Error("invalid inventory");
        for (const value of page["data"]) {
          const threadId = id(value);
          if (!threadId) throw new Error("invalid thread");
          if (threadId !== this.root && !this.threads.has(threadId)) this.ensure(threadId);
        }
        const next = page["nextCursor"];
        if (next !== null && next !== undefined && typeof next !== "string")
          throw new Error("invalid cursor");
        cursor = typeof next === "string" && next ? next : undefined;
        if (cursor && (cursors.has(cursor) || cursors.size >= 256))
          throw new Error("repeated cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch {
      this.gap("inventory");
    } finally {
      this.scanning = false;
      this.inventory();
      void this.readPending();
    }
  }
  snapshot(): InFlight {
    return {
      revision: this.revision,
      threads: [...this.threads.values()]
        .filter((t) => t.verified && t.active)
        .map((t) => structuredClone(t.child))
        .sort((a, b) => a.threadId.localeCompare(b.threadId)),
      complete:
        this.complete &&
        !this.scanning &&
        ![...this.threads.values()].some((t) => t.verified === null),
      observedAt: new Date().toISOString(),
    };
  }
  notification(method: string, params: Record<string, unknown>) {
    if (this.stopped) return;
    const threadId = id(params["threadId"]);
    const item = row(params["item"]);
    if (threadId === this.root) {
      if (
        method === "item/started" &&
        item["type"] === "mcpToolCall" &&
        item["server"] === CONTROL_MCP_SERVER_NAME &&
        item["tool"] === MAILBOX_TOOL
      ) {
        const callId = id(item["id"]);
        if (callId) {
          this.calls.add(callId);
          while (this.calls.size > 256) this.calls.delete(this.calls.values().next().value!);
          for (const wake of this.callWaiters) wake();
        }
      }
      if (
        method === "item/completed" &&
        item["type"] === "functionCallOutput" &&
        item["name"] === MAILBOX_OUTPUT &&
        item["namespace"] === MAILBOX_NAMESPACE &&
        typeof item["output"] === "string"
      ) {
        try {
          const notice = wakeNoticeSchema.parse(JSON.parse(item["output"]));
          const turnId = id(params["turnId"]),
            itemId = id(item["id"]);
          if (notice.rootThreadId === this.root && turnId && itemId)
            this.publish({ kind: "recorded", eventId: notice.eventId, turnId, itemId });
        } catch {
          /* Other native tool outputs do not identify our submissions. */
        }
      }
      if (
        (method === "item/started" || method === "item/completed") &&
        item["type"] === "subAgentActivity"
      ) {
        const childId = id(item["agentThreadId"]);
        const tracked = childId && this.ensure(childId);
        if (tracked) tracked.child.agentPath = this.text(item["agentPath"], 128);
        this.inventory();
        void this.readPending();
      }
      return;
    }
    if (method === "thread/started") {
      const raw = row(params["thread"]),
        childId = id(raw["id"]);
      if (!childId || childId === this.root) return;
      const tracked = this.ensure(childId);
      if (tracked) {
        try {
          this.metadata(tracked, raw, 0);
        } catch {
          this.reads.add(childId);
        }
      }
    } else if (
      threadId &&
      [
        "turn/started",
        "turn/completed",
        "thread/status/changed",
        "thread/name/updated",
        "thread/closed",
      ].includes(method)
    ) {
      const tracked = this.ensure(threadId);
      if (!tracked) return;
      tracked.revision++;
      if (method === "thread/name/updated")
        tracked.child.name = this.text(params["threadName"], 64);
      if (method === "thread/status/changed") {
        const status = row(params["status"]);
        // Terminal turn facts take precedence over a trailing coarse active-status event.
        if (!tracked.child.turnId) tracked.active = status["type"] === "active";
        tracked.child.waitingOn = this.flags(status["activeFlags"]);
      }
      if (method === "thread/closed") tracked.active = false;
      if (method.startsWith("turn/")) {
        const turn = row(params["turn"]),
          turnId = id(turn["id"]),
          status = turn["status"];
        if (!turnId) return;
        const key = `${method}:${turnId}`;
        if (tracked.seen.has(key)) return;
        if (tracked.seen.size >= 4096) {
          this.gap("capacity");
          return;
        }
        tracked.seen.add(key);
        const observedAt = new Date().toISOString();
        if (method === "turn/started") {
          if (tracked.seen.has(`turn/completed:${turnId}`)) return;
          tracked.child.turnId = turnId;
          tracked.active = true;
          this.lifecycle(tracked, { kind: "started", turnId, observedAt });
        } else if (status === "completed" || status === "failed" || status === "interrupted") {
          if (!tracked.child.turnId || tracked.child.turnId === turnId) {
            tracked.active = false;
            tracked.child.turnId = turnId;
          }
          this.lifecycle(tracked, { kind: "completed", turnId, status, observedAt });
        }
      }
    } else return;
    this.inventory();
    void this.readPending();
  }
  async authorize(caller: MailboxCaller): Promise<boolean> {
    if (caller.threadId !== this.root || this.stopped) return false;
    if (!this.calls.has(caller.callId) && this.callWaiters.size >= 32) return false;
    if (!this.calls.has(caller.callId))
      await new Promise<void>((resolve) => {
        const done = () => {
          if (this.calls.has(caller.callId) || this.stopped) finish();
        };
        const finish = () => {
          clearTimeout(timer);
          this.callWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        this.callWaiters.add(done);
      });
    return !this.stopped && this.calls.has(caller.callId);
  }
  stop() {
    this.stopped = true;
    this.reads.clear();
    for (const wake of this.callWaiters) wake();
  }
  private text(value: unknown, limit: number): string | null {
    if (typeof value !== "string") return null;
    for (const secret of this.secrets)
      if (secret) value = (value as string).replaceAll(secret, "[redacted]");
    return (value as string).slice(0, limit);
  }
  private flags(value: unknown): Child["waitingOn"] {
    return Array.isArray(value)
      ? [...new Set(value)].filter(
          (x): x is Child["waitingOn"][number] =>
            x === "waitingOnApproval" || x === "waitingOnUserInput",
        )
      : [];
  }
  private ensure(threadId: string): Tracked | undefined {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.verified === null) this.reads.add(threadId);
      return existing;
    }
    if (this.threads.size >= 256) {
      this.gap("capacity");
      return;
    }
    const tracked: Tracked = {
      child: { threadId, turnId: null, name: null, agentPath: null, waitingOn: [] },
      verified: null,
      revision: 0,
      active: false,
      pending: [],
      seen: new Set(),
    };
    this.threads.set(threadId, tracked);
    this.reads.add(threadId);
    return tracked;
  }
  private metadata(tracked: Tracked, raw: Record<string, unknown>, revision: number) {
    if (
      raw["id"] !== tracked.child.threadId ||
      typeof raw["cwd"] !== "string" ||
      !("parentThreadId" in raw)
    )
      throw new Error("incomplete metadata");
    tracked.verified = raw["parentThreadId"] === this.root && raw["cwd"] === this.workspace;
    tracked.child.name ??= this.text(raw["name"] ?? raw["agentNickname"], 64);
    if (revision === tracked.revision && !tracked.child.turnId) {
      tracked.active = row(raw["status"])["type"] === "active";
      tracked.child.waitingOn = this.flags(row(raw["status"])["activeFlags"]);
    }
    this.reads.delete(tracked.child.threadId);
    this.inventory();
    const pending = tracked.pending.splice(0);
    for (const event of pending) this.lifecycle(tracked, event);
  }
  private lifecycle(tracked: Tracked, event: TurnEvent) {
    if (tracked.verified === null) {
      if (tracked.pending.length < 256) tracked.pending.push(event);
      else this.gap("capacity");
      return;
    }
    if (!tracked.verified) return;
    this.inventory();
    const child = childSchema.parse({ ...tracked.child, turnId: event.turnId });
    if (event.kind === "started")
      this.publish({ kind: "started", child, observedAt: event.observedAt });
    else
      this.publish({
        kind: "completed",
        completion: {
          ...child,
          turnId: event.turnId,
          status: event.status,
          observedAt: event.observedAt,
        },
      });
  }
  private async readPending() {
    if (this.reading || this.scanning || this.stopped) return;
    this.reading = true;
    try {
      for (const threadId of this.reads) {
        this.reads.delete(threadId);
        const tracked = this.threads.get(threadId)!;
        if (tracked.verified !== null) continue;
        const revision = tracked.revision;
        try {
          const raw = row(
            row(await this.request("thread/read", { threadId, includeTurns: false }, 2000))[
              "thread"
            ],
          );
          if (this.stopped) return;
          this.metadata(tracked, raw, revision);
        } catch {
          this.gap("metadata");
        }
      }
    } finally {
      this.reading = false;
      this.inventory();
    }
  }
  private inventory() {
    if (this.stopped) return;
    const inventory = this.snapshot();
    const signature = JSON.stringify([inventory.threads, inventory.complete]);
    if (signature === this.lastInventory) return;
    this.lastInventory = signature;
    inventory.revision = ++this.revision;
    this.publish({ kind: "inventory", inventory });
  }
  private gap(reason: "capacity" | "metadata" | "inventory") {
    if (this.stopped) return;
    this.complete = false;
    this.publish({ kind: "gap", reason });
  }
}
