import {
  type ControllerEvent,
  type ConversationEvent,
  EVENT_PROTOCOL_VERSION,
  type LifecycleEvent,
  type RuntimeView,
  type ThreadInventory,
  type ThreadSnapshot,
} from "./contract.ts";
import {
  type ConversationNotification,
  MAX_HISTORY_BYTES,
  ObservationError,
} from "./conversation.ts";
import { ConversationProjection } from "./conversation-projection.ts";
import type { VoiceNotification } from "./voice.ts";

/** Retained lifecycle projection plus transient voice events; no conversation state. */
export class LifecycleFeed {
  private value: ThreadSnapshot;
  private readonly replayEvents: { frame: ConversationEvent; bytes: number }[] = [];
  private replayBytes = 0;
  private replayFloor = 0;
  private revision = 0;
  private readonly projection = new ConversationProjection();
  private readonly listeners = new Set<(event: ControllerEvent) => void>();
  constructor(instanceId: string) {
    this.value = {
      instanceId,
      generation: 1,
      sequence: 0,
      runtime: { phase: "starting", workspace: "", mainThreadId: "" },
      inventory: "pending",
      threads: [],
    };
  }
  snapshot(): ThreadSnapshot {
    return structuredClone(this.value);
  }
  listen(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  runtime(generation: number, runtime: RuntimeView): void {
    if (
      generation === this.value.generation &&
      JSON.stringify(runtime) === JSON.stringify(this.value.runtime)
    )
      return;
    const replaced = generation !== this.value.generation;
    this.value.generation = generation;
    this.value.runtime = { ...runtime };
    const unavailable = !["starting", "ready"].includes(runtime.phase);
    if (replaced || unavailable) {
      this.value.threads = [];
      this.value.inventory = unavailable ? "unavailable" : "pending";
      this.replayEvents.length = 0;
      this.replayBytes = 0;
      this.replayFloor = this.value.sequence;
      this.projection.reset();
      if (replaced) this.revision = 0;
    } else if (this.value.inventory === "unavailable") this.value.inventory = "pending";
    // A runtime event carries the inventory too: it is an explicit reset boundary.
    this.emit("runtime.state.changed", {
      runtime: this.value.runtime,
      inventory: this.value.inventory,
      threads: this.value.threads,
    });
  }
  update(inventory: ThreadInventory): void {
    if (!["starting", "ready"].includes(this.value.runtime.phase)) return;
    const before = this.value.threads;
    const next = [...inventory.threads].sort((a, b) => a.id.localeCompare(b.id));
    const state = inventory.complete ? "ready" : "incomplete";
    const membershipChanged =
      state !== this.value.inventory ||
      before.map((t) => t.id).join("\n") !== next.map((t) => t.id).join("\n");
    this.value.inventory = state;
    this.value.threads = structuredClone(next);
    if (membershipChanged)
      this.emit("threads.changed", { inventory: state, threads: this.value.threads });
    else
      for (let index = 0; index < next.length; index++) {
        if (JSON.stringify(before[index]) !== JSON.stringify(next[index]))
          this.emit("thread.state.changed", { thread: next[index] });
      }
  }
  voice(notification: VoiceNotification): void {
    if (!["starting", "ready"].includes(this.value.runtime.phase)) return;
    this.publish(
      Object.assign({}, notification, {
        v: EVENT_PROTOCOL_VERSION as typeof EVENT_PROTOCOL_VERSION,
        type: "event" as const,
        data: {
          ...notification.data,
          instanceId: this.value.instanceId,
          generation: this.value.generation,
          sequence: ++this.value.sequence,
        },
      }),
    );
  }
  conversation(notification: ConversationNotification): void {
    if (
      !["starting", "ready"].includes(this.value.runtime.phase) ||
      notification.revision <= this.revision
    )
      return;
    if (notification.revision > this.revision + 1 && notification.event !== "conversation.gap")
      this.conversation({
        event: "conversation.gap",
        revision: notification.revision - 1,
        data: { threadId: null, reason: "source_gap" },
      });
    this.revision = notification.revision;
    this.projection.apply(notification);
    const frame: ConversationEvent = {
      v: EVENT_PROTOCOL_VERSION,
      type: "event",
      event: notification.event,
      data: {
        ...notification.data,
        revision: notification.revision,
        instanceId: this.value.instanceId,
        generation: this.value.generation,
        sequence: ++this.value.sequence,
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    this.replayEvents.push({ frame, bytes });
    this.replayBytes += bytes;
    while (this.replayEvents.length > 512 || this.replayBytes > 8 * 1024 * 1024) {
      const old = this.replayEvents.shift()!;
      this.replayBytes -= old.bytes;
      this.replayFloor = old.frame.data.sequence;
    }
    this.publish(frame);
  }
  replay(afterSequence: number, limit: number) {
    if (afterSequence < this.replayFloor) throw new ObservationError("resync_required");
    if (afterSequence > this.value.sequence) throw new ObservationError("invalid_params");
    const frames: ConversationEvent[] = [];
    let bytes = 0;
    let hasMore = false;
    for (const entry of this.replayEvents) {
      if (entry.frame.data.sequence <= afterSequence) continue;
      if (frames.length >= limit || bytes + entry.bytes > MAX_HISTORY_BYTES - 4096) {
        hasMore = true;
        break;
      }
      frames.push(entry.frame);
      bytes += entry.bytes;
    }
    return structuredClone({
      instanceId: this.value.instanceId,
      generation: this.value.generation,
      events: frames,
      throughSequence: hasMore ? frames.at(-1)!.data.sequence : this.value.sequence,
      hasMore,
    });
  }
  live(threadId: string) {
    return {
      instanceId: this.value.instanceId,
      generation: this.value.generation,
      ...this.projection.snapshot(threadId, this.value.sequence, this.revision),
    };
  }
  private emit(event: LifecycleEvent["event"], data: Record<string, unknown>): void {
    const frame: LifecycleEvent = {
      v: EVENT_PROTOCOL_VERSION,
      type: "event",
      event,
      data: {
        ...data,
        instanceId: this.value.instanceId,
        generation: this.value.generation,
        sequence: ++this.value.sequence,
      },
    };
    this.publish(frame);
  }
  private publish(frame: ControllerEvent): void {
    for (const listener of this.listeners) listener(structuredClone(frame));
  }
}
