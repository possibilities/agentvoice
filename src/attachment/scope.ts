import { type AttachmentIdentity, object } from "./policy.ts";

export type ReadAttachmentThread = (threadId: string, timeoutMs: number) => Promise<unknown>;

/** Native ancestry is immutable; positive admissions live only as long as the root grant. */
export class AttachmentScope {
  readonly threads: Set<string>;
  private readonly pending = new Map<string, Promise<boolean>>();
  private closed = false;

  constructor(
    readonly root: AttachmentIdentity,
    private readonly read: ReadAttachmentThread,
  ) {
    this.threads = new Set([root.threadId]);
  }

  close(): void {
    this.closed = true;
    this.threads.clear();
  }

  async allows(id: unknown, deadline = Date.now() + 6_000): Promise<boolean> {
    if (this.closed || typeof id !== "string" || !id || id.length > 128) return false;
    if (this.threads.has(id)) return true;
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 4) return false;
    const check = this.verify(id, deadline).catch(() => false);
    this.pending.set(id, check);
    try {
      return await check;
    } finally {
      this.pending.delete(id);
    }
  }

  private async verify(id: string, deadline: number): Promise<boolean> {
    const path = new Set<string>();
    let current = id;
    for (let depth = 0; depth < 32; depth++) {
      if (this.closed) return false;
      if (this.threads.has(current)) {
        if (this.threads.size + path.size > 512) return false;
        for (const entry of path) this.threads.add(entry);
        return true;
      }
      if (path.has(current) || Date.now() >= deadline) return false;
      path.add(current);
      const thread = object(
        object(await this.read(current, Math.min(2_000, deadline - Date.now())))["thread"],
      );
      if (thread["id"] !== current || thread["cwd"] !== this.root.workspace) return false;
      const parent = thread["parentThreadId"];
      if (typeof parent !== "string" || !parent || parent.length > 128) return false;
      current = parent;
    }
    return false;
  }
}
