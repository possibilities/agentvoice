import { randomUUID } from "node:crypto";
import { ControlError } from "../control/types.ts";
import {
  type Completion,
  type InFlight,
  MAX_MAILBOX_ENTRIES,
  type MailboxEntry,
  type MailboxOpenResult,
  type MailboxPublish,
  type MailboxSnapshot,
  type WakeNotice,
  type WakeOutcome,
  type WakeState,
} from "./contract.ts";

/** One call's consumable metadata, independent of disposable native runtimes. */
export class ThreadMailbox {
  private entries: MailboxEntry[] = [];
  private unavailable = 0;
  private revision = 0;
  private inventory: InFlight = {
    revision: 0,
    threads: [],
    complete: false,
    observedAt: new Date().toISOString(),
  };
  private readonly seen = new Set<string>();
  private readonly wakes = new Map<string, WakeState>();
  private readonly opened = new Map<string, MailboxOpenResult>();
  private openedBytes = 0;
  constructor(
    private readonly instanceId: string,
    private readonly publish: MailboxPublish,
  ) {}
  snapshot(): MailboxSnapshot {
    return structuredClone({
      revision: this.revision,
      completed: this.entries.length + this.unavailable,
      unavailableCompletions: this.unavailable,
      entries: this.entries,
      inFlight: this.inventory,
      recentWakes: [...this.wakes.values()].slice(-32),
    });
  }
  update(inventory: InFlight): void {
    if (inventory.revision < this.inventory.revision) return;
    const changed =
      JSON.stringify([inventory.threads, inventory.complete]) !==
      JSON.stringify([this.inventory.threads, this.inventory.complete]);
    this.inventory = structuredClone(inventory);
    if (changed) this.changed();
  }
  gap(reason: "capacity" | "metadata" | "inventory") {
    this.inventory.complete = false;
    this.publish("mailbox.gap", { reason, unavailableCompletions: this.unavailable });
    this.changed();
  }
  complete(completion: Completion, generation: number): string | undefined {
    const key = JSON.stringify([completion.threadId, completion.turnId]);
    if (this.seen.has(key)) return;
    // Never evict deduplication identities and accidentally re-wake on old native events.
    if (this.seen.size >= 16384) {
      this.gap("capacity");
      return;
    }
    this.seen.add(key);
    const eventId = randomUUID();
    const entry = { ...completion, eventId };
    if (this.entries.length < MAX_MAILBOX_ENTRIES) this.entries.push(entry);
    else {
      this.unavailable++;
      this.gap("capacity");
    }
    this.wakes.set(eventId, {
      eventId,
      generation,
      status: "pending",
      notice: null,
      turnId: null,
      recorded: null,
    });
    this.publish("mailbox.child.completed", { entry });
    this.changed();
    return eventId;
  }
  submitting(notice: WakeNotice, generation: number) {
    const wake = this.wakes.get(notice.eventId);
    if (!wake || wake.generation !== generation || wake.status !== "pending") return;
    wake.notice = structuredClone(notice);
    wake.status = "submitting";
    this.wakeChanged(wake);
  }
  outcome(eventId: string, generation: number, outcome: WakeOutcome) {
    const wake = this.wakes.get(eventId);
    if (!wake || wake.generation !== generation) return;
    wake.status = outcome.status;
    if (outcome.status === "accepted") wake.turnId = outcome.turnId;
    this.wakeChanged(wake);
  }
  recorded(eventId: string, generation: number, turnId: string, itemId: string) {
    const wake = this.wakes.get(eventId);
    if (!wake || wake.generation !== generation || wake.recorded) return;
    wake.recorded = { turnId, itemId };
    this.wakeChanged(wake);
  }
  unavailableRuntime() {
    this.inventory = {
      revision: 0,
      threads: [],
      complete: false,
      observedAt: new Date().toISOString(),
    };
    this.changed();
    for (const wake of this.wakes.values()) {
      if (wake.status === "pending" || wake.status === "submitting") {
        wake.status = "unknown";
        this.wakeChanged(wake);
      }
    }
  }
  cached(operationId: string): MailboxOpenResult | undefined {
    const value = this.opened.get(operationId);
    return value && structuredClone(value);
  }
  open(operationId: string): MailboxOpenResult {
    const cached = this.cached(operationId);
    if (cached) return cached;
    // Refuse before consuming rather than evicting retry results and consuming a newer batch.
    if (this.opened.size >= 4096 || this.openedBytes >= 16 * 1024 * 1024)
      throw new ControlError("unavailable", "Mailbox opening retry cache is full for this call");
    const entries: MailboxEntry[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= 32 || bytes + size > 12 * 1024) break;
      entries.push(entry);
      bytes += size;
    }
    const threads: InFlight["threads"] = [];
    for (const thread of this.inventory.threads) {
      const size = Buffer.byteLength(JSON.stringify(thread));
      if (bytes + size > 20 * 1024) break;
      threads.push(thread);
      bytes += size;
    }
    const unavailableCompletions = this.unavailable;
    this.entries.splice(0, entries.length);
    this.unavailable = 0;
    const result: MailboxOpenResult = structuredClone({
      operationId,
      instanceId: this.instanceId,
      revision: this.revision + 1,
      entries,
      unavailableCompletions,
      remainingCompleted: this.entries.length,
      inFlight: { ...this.inventory, threads },
      inFlightTotal: this.inventory.threads.length,
      inFlightTruncated: threads.length !== this.inventory.threads.length,
    });
    this.opened.set(operationId, result);
    this.openedBytes += Buffer.byteLength(JSON.stringify(result));
    this.publish("mailbox.opened", {
      operationId,
      eventIds: entries.map((e) => e.eventId),
      remainingCompleted: result.remainingCompleted,
      unavailableCompletions,
    });
    this.changed();
    return structuredClone(result);
  }
  clear() {
    this.entries = [];
    this.unavailable = 0;
    this.opened.clear();
    this.openedBytes = 0;
    this.seen.clear();
    this.wakes.clear();
    this.unavailableRuntime();
  }
  private wakeChanged(wake: WakeState) {
    this.publish("mailbox.wake.changed", { wake: structuredClone(wake) });
    this.changed();
  }
  private changed() {
    this.revision++;
    this.publish("mailbox.changed", { state: this.snapshot() });
  }
}
