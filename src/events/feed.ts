import {
  EVENT_PROTOCOL_VERSION,
  type LifecycleEvent,
  type RuntimeView,
  type ThreadInventory,
  type ThreadSnapshot,
} from "./contract.ts";

/** Controller-lifetime state. No native payloads or conversation content are retained here. */
export class LifecycleFeed {
  private value: ThreadSnapshot;
  private readonly listeners = new Set<(event: LifecycleEvent) => void>();
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
  listen(listener: (event: LifecycleEvent) => void): () => void {
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
    for (const listener of this.listeners) listener(structuredClone(frame));
  }
}
