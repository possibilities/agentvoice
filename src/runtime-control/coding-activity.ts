import { z } from "zod";
import type { ThreadInventory, ThreadView } from "../events/contract.ts";

export const codingActivitySchema = z.enum(["working", "blocked", "idle", "unknown"]);
export type CodingActivity = z.infer<typeof codingActivitySchema>;

/** Native work, not a claim about cognition. Only the root and verified direct children count. */
export class CodingActivityReducer {
  private rootId = "";
  private root: ThreadView | undefined;
  private turn: ThreadView["turn"] = null;
  private readonly seen = new Map<string, "inProgress" | "terminal">();
  private overflow = false;
  private children: ThreadView[] | undefined;
  private inventoryComplete = false;

  reset(rootId = ""): void {
    this.rootId = rootId;
    this.root = undefined;
    this.turn = null;
    this.seen.clear();
    this.overflow = false;
    this.children = undefined;
    this.inventoryComplete = false;
  }

  threads(inventory: ThreadInventory): void {
    this.inventoryComplete = inventory.complete;
    this.children = inventory.threads
      .filter((thread) => thread.parentThreadId === this.rootId)
      .map((thread) => structuredClone(thread));
    const root = inventory.threads.find((thread) => thread.id === this.rootId);
    if (!root || root.status === "notLoaded" || root.status === "systemError") {
      // A late snapshot of the interrupted turn must not resurrect an unloaded root.
      if (this.turn) {
        this.seen.set(this.turn.id, "terminal");
        this.turn = { id: this.turn.id, status: "interrupted" };
      }
      this.root = undefined;
      return;
    }
    this.root = structuredClone(root);
    const next = root.turn;
    if (!next) return;
    const prior = this.seen.get(next.id);
    if (!prior && this.seen.size >= 4096) {
      this.overflow = true;
      this.turn = null;
      return;
    }
    if (next.status === "inProgress") {
      if (prior) return;
      this.seen.set(next.id, "inProgress");
      this.turn = { ...next };
    } else {
      this.seen.set(next.id, "terminal");
      // Completion of an older turn cannot stop a successor that is still running.
      if (!this.turn || this.turn.id === next.id) this.turn = { ...next };
    }
  }

  rootGap(): void {
    this.root = undefined;
  }

  state(): CodingActivity {
    let root: CodingActivity = "unknown";
    if (this.root && !this.overflow) {
      if (this.turn?.status === "inProgress" || (!this.turn && this.root.status === "active"))
        root = this.root.activeFlags.length ? "blocked" : "working";
      else if (this.turn || this.root.status === "idle") root = "idle";
    }
    const activeChildren = this.children?.filter(
      (child) => child.turn?.status === "inProgress" || (!child.turn && child.status === "active"),
    );
    if (root === "working" || activeChildren?.some((child) => !child.activeFlags.length))
      return "working";
    if (root === "unknown" || !this.inventoryComplete || !activeChildren) return "unknown";
    return root === "blocked" || activeChildren.length ? "blocked" : "idle";
  }
}
