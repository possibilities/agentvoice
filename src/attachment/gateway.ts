import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { NativeEndpoint } from "../core/native-listener.ts";
import {
  type AttachmentIdentity,
  attachmentNotification,
  attachmentResult,
  attachmentServerRequest,
  object,
  validateAttachmentRequest,
} from "./policy.ts";
import { AttachmentScope, type ReadAttachmentThread } from "./scope.ts";

export type AttachmentTicket = AttachmentIdentity & { url: string; token: string; codex: string };
type Grant = {
  identity: AttachmentIdentity;
  scope: AttachmentScope;
  token: string;
  expires: number;
  peers: Set<ServerWebSocket<Peer>>;
  watching: boolean;
  attached: boolean;
};
type Peer = {
  grant: Grant;
  watch: boolean;
  upstream?: WebSocket;
  queued: string[];
  pending: Map<
    string | number,
    {
      method: string;
      identity: AttachmentIdentity;
      sequence: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  initialized: boolean;
  serverRequests: Set<string | number>;
  initializing: boolean;
  unsubscribed: boolean;
  hookTrusts: Map<string, string>;
  sequence: number;
  incoming: Promise<void>;
  outgoing: Promise<void>;
  queuedFrames: number;
  queuedBytes: number;
};
const MAX_BYTES = 4 * 1024 * 1024;

/** Runtime-owned native protocol gateway; grants cannot outlive their selected thread. */
export class AttachmentGateway {
  private readonly grants = new Map<string, Grant>();
  private readonly server;
  private readonly expiry: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly native: NativeEndpoint,
    private readonly codex: string,
    private readonly readThread: ReadAttachmentThread,
    private readonly trace?: (method: string, outcome: string) => void,
  ) {
    this.server = Bun.serve<Peer>({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 1024,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (
          this.closed ||
          request.headers.has("origin") ||
          request.headers.get("host") !== `127.0.0.1:${server.port}`
        )
          return new Response("forbidden", { status: 403 });
        const grant = this.grants.get(
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
        );
        if (!grant || grant.expires < Date.now())
          return new Response("expired attachment", { status: 401 });
        const watch = url.pathname === "/watch";
        if (
          request.method !== "GET" ||
          (!watch && url.pathname !== "/") ||
          (watch ? grant.watching : grant.attached)
        )
          return new Response("attachment already connected or invalid path", { status: 409 });
        if (!watch && !grant.watching)
          return new Response("attachment watcher required", { status: 409 });
        const data: Peer = {
          grant,
          watch,
          queued: [],
          pending: new Map(),
          initialized: false,
          serverRequests: new Set(),
          initializing: false,
          unsubscribed: false,
          hookTrusts: new Map(),
          sequence: 0,
          incoming: Promise.resolve(),
          outgoing: Promise.resolve(),
          queuedFrames: 0,
          queuedBytes: 0,
        };
        if (!server.upgrade(request, { data }))
          return new Response("WebSocket required", { status: 400 });
        if (watch) grant.watching = true;
        else grant.attached = true;
      },
      websocket: {
        maxPayloadLength: MAX_BYTES,
        backpressureLimit: MAX_BYTES,
        closeOnBackpressureLimit: true,
        open: (peer) => this.open(peer),
        message: (peer, data) => {
          // Arrival invalidates a prior unsubscribe even while ancestry is being checked.
          peer.data.sequence++;
          peer.data.unsubscribed = false;
          const sequence = peer.data.sequence;
          this.enqueue(peer, "incoming", data, () => this.message(peer, data, sequence));
        },
        close: (peer, code) =>
          this.drop(
            peer.data.grant,
            !peer.data.watch && (code === 1000 || peer.data.unsubscribed) ? 1000 : 4001,
          ),
      },
    });
    this.expiry = setInterval(() => {
      for (const grant of this.grants.values())
        if (!grant.attached && grant.expires < Date.now()) this.drop(grant);
    }, 5_000);
    this.expiry.unref();
  }

  issue(identity: AttachmentIdentity): AttachmentTicket {
    if (this.closed || this.grants.size >= 8)
      throw new Error("Attachment is unavailable or at capacity");
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, {
      identity: { ...identity },
      scope: new AttachmentScope({ ...identity }, this.readThread),
      token,
      expires: Date.now() + 30_000,
      peers: new Set(),
      watching: false,
      attached: false,
    });
    return { ...identity, url: `ws://127.0.0.1:${this.server.port}`, token, codex: this.codex };
  }

  revoke(): void {
    for (const grant of [...this.grants.values()]) this.drop(grant);
  }
  close(): void {
    this.closed = true;
    clearInterval(this.expiry);
    this.revoke();
    this.server.stop(true);
  }
  private active(grant: Grant): boolean {
    return !this.closed && this.grants.get(grant.token) === grant;
  }
  private drop(grant: Grant, code = 4001): void {
    if (!this.grants.delete(grant.token)) return;
    grant.scope.close();
    for (const peer of grant.peers) {
      for (const request of peer.data.pending.values()) clearTimeout(request.timer);
      peer.data.pending.clear();
      peer.data.serverRequests.clear();
      peer.data.upstream?.close();
      peer.close(
        code,
        code === 1000 ? "TUI disconnected" : "Attachment ended; run agentvoice attach agent again",
      );
    }
    grant.peers.clear();
  }
  private open(peer: ServerWebSocket<Peer>): void {
    const state = peer.data;
    if (!this.active(state.grant)) {
      peer.close();
      return;
    }
    state.grant.peers.add(peer);
    if (state.watch) {
      peer.send(JSON.stringify({ ready: true }));
      return;
    }
    const upstream = new WebSocket(this.native.url, {
      headers: { Authorization: `Bearer ${this.native.token}` },
    });
    state.upstream = upstream;
    const timer = setTimeout(() => this.drop(state.grant), 10_000);
    upstream.addEventListener("open", () => {
      clearTimeout(timer);
      if (!this.active(state.grant)) {
        upstream.close();
        return;
      }
      for (const text of state.queued) upstream.send(text);
      state.queued.length = 0;
    });
    upstream.addEventListener("close", () => {
      clearTimeout(timer);
      this.drop(state.grant);
    });
    upstream.addEventListener("error", () => {
      clearTimeout(timer);
      this.drop(state.grant);
    });
    upstream.addEventListener("message", ({ data }) => {
      this.enqueue(peer, "outgoing", data, () => this.nativeMessage(peer, data));
    });
  }
  private async nativeMessage(peer: ServerWebSocket<Peer>, data: unknown): Promise<void> {
    const state = peer.data;
    if (!this.active(state.grant)) return;
    try {
      if (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES)
        throw new Error("Invalid native frame");
      const frame = object(JSON.parse(data));
      const id = frame["id"];
      const method = frame["method"];
      const params = typeof method === "string" ? object(frame["params"] ?? {}) : {};
      const threadId =
        method === "thread/started" ? object(params["thread"])["id"] : params["threadId"];
      let eventIdentity = state.grant.identity;
      if (threadId !== undefined) {
        if (
          typeof method === "string" &&
          (method.startsWith("thread/realtime/") || method.startsWith("rawResponse"))
        )
          return;
        if (!(await state.grant.scope.allows(threadId))) return;
        eventIdentity = { ...eventIdentity, threadId: threadId as string };
      }
      if (id !== undefined && typeof method === "string") {
        if (
          (typeof id !== "string" && typeof id !== "number") ||
          !attachmentServerRequest(method, params, eventIdentity)
        )
          return;
        if (state.serverRequests.size >= 64 && !state.serverRequests.has(id))
          throw new Error("Too many native questions");
        state.serverRequests.add(id);
      } else if (id !== undefined) {
        const request = state.pending.get(id as string | number);
        if (!request) throw new Error("Uncorrelated native response");
        state.pending.delete(id as string | number);
        clearTimeout(request.timer);
        if (!frame["error"]) {
          if (request.method === "hooks/list") {
            state.hookTrusts.clear();
            const rows = object(frame["result"])["data"];
            if (!Array.isArray(rows)) throw new Error("Invalid hooks inventory");
            const row = rows.find(
              (candidate) => object(candidate)["cwd"] === request.identity.workspace,
            );
            if (row) {
              const hooks = object(row)["hooks"];
              if (!Array.isArray(hooks) || hooks.length > 256)
                throw new Error("Invalid hooks inventory");
              for (const raw of hooks) {
                const hook = object(raw);
                if (
                  ["untrusted", "modified"].includes(hook["trustStatus"] as string) &&
                  typeof hook["key"] === "string" &&
                  typeof hook["currentHash"] === "string"
                )
                  state.hookTrusts.set(hook["key"], hook["currentHash"]);
              }
            }
          }
          if (request.method === "thread/list" || request.method === "thread/loaded/list") {
            const rows = object(frame["result"])["data"];
            if (!Array.isArray(rows) || rows.length > 512)
              throw new Error("Invalid thread inventory");
            const deadline = Date.now() + 6_000;
            for (const row of rows) {
              await state.grant.scope.allows(
                request.method === "thread/loaded/list" ? row : object(row)["id"],
                deadline,
              );
            }
          }
          frame["result"] = attachmentResult(
            request.method,
            frame["result"],
            request.identity,
            state.grant.scope.threads,
          );
          if (request.method === "initialize") state.initialized = true;
          // Stock TUI /quit unsubscribes only the displayed thread before closing TCP.
          if (request.method === "thread/unsubscribe") {
            state.unsubscribed = request.sequence === state.sequence && state.pending.size === 0;
          }
        }
      } else if (
        typeof method !== "string" ||
        !attachmentNotification(method, params, eventIdentity)
      )
        return;
      if (
        method === "serverRequest/resolved" &&
        !state.serverRequests.delete(params["requestId"] as string | number)
      )
        return;
      if (!this.active(state.grant)) return;
      peer.send(JSON.stringify(frame).replaceAll(this.native.token, "[redacted]"));
    } catch {
      this.drop(state.grant);
    }
  }
  private async message(
    peer: ServerWebSocket<Peer>,
    data: string | Buffer,
    sequence: number,
  ): Promise<void> {
    const state = peer.data;
    if (!this.active(state.grant)) return;
    let id: string | number | undefined;
    let registered = false;
    let method = "invalid frame";
    try {
      if (state.watch || typeof data !== "string") throw new Error("Invalid attachment frame");
      const frame = object(JSON.parse(data));
      if (typeof frame["id"] === "string" || typeof frame["id"] === "number") id = frame["id"];
      if (id !== undefined && frame["method"] === undefined) {
        if (
          Object.keys(frame).some((key) => !["id", "result", "error", "jsonrpc"].includes(key)) ||
          Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")
        )
          throw new Error("Invalid client answer");
        // Another client may already have answered. Native owns resolution and replay.
        if (!state.serverRequests.delete(id)) return;
        this.forward(peer, JSON.stringify(frame));
        return;
      }
      if (Object.keys(frame).some((key) => !["id", "method", "params", "jsonrpc"].includes(key)))
        throw new Error("Unsupported client frame");
      if (typeof frame["method"] !== "string" || "result" in frame || "error" in frame)
        throw new Error("Client responses are not supported");
      method = frame["method"];
      if (id === undefined) {
        if (method !== "initialized" || !state.initialized)
          throw new Error("Unsupported client notification");
      } else {
        if (state.pending.has(id)) {
          this.drop(state.grant);
          return;
        }
        if (method === "initialize" ? state.initializing : !state.initialized)
          throw new Error("Invalid initialization sequence");
        const params = object(frame["params"] ?? {});
        let identity = state.grant.identity;
        const target = method === "thread/list" ? params["ancestorThreadId"] : params["threadId"];
        // Validate the method and payload before making even a metadata read for admission.
        const candidate =
          typeof target === "string" && !method.startsWith("thread/realtime/")
            ? { ...identity, threadId: target }
            : identity;
        validateAttachmentRequest(method, params, candidate, state.hookTrusts);
        // A new inventory supersedes the old one; a permitted trust write consumes it.
        if (method === "hooks/list" || method === "config/batchWrite") state.hookTrusts.clear();
        if (candidate.threadId !== identity.threadId) {
          if (!(await state.grant.scope.allows(candidate.threadId)))
            throw new Error("Attachment requires a verified descendant in the selected workspace");
          identity = candidate;
        }
        if (!this.active(state.grant)) return;
        frame["params"] = params;
        if (method === "initialize") state.initializing = true;
        if (state.pending.size >= 64) throw new Error("Too many attachment requests");
        state.pending.set(id, {
          method,
          identity,
          sequence,
          timer: setTimeout(() => this.drop(state.grant), 30_000),
        });
        registered = true;
      }
      if (!this.active(state.grant)) return;
      const forwarded = JSON.stringify(frame);
      this.trace?.(method, "forwarded");
      this.forward(peer, forwarded);
    } catch (error) {
      this.trace?.(method, error instanceof Error ? error.message : "rejected");
      if (id === undefined || registered) this.drop(state.grant);
      else
        peer.send(
          JSON.stringify({
            id,
            error: {
              code: -32600,
              message: error instanceof Error ? error.message : "Attachment request rejected",
            },
          }),
        );
    }
  }
  private enqueue(
    peer: ServerWebSocket<Peer>,
    direction: "incoming" | "outgoing",
    data: unknown,
    run: () => Promise<void>,
  ): void {
    const state = peer.data;
    if (!this.active(state.grant)) return;
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : MAX_BYTES;
    state.queuedFrames++;
    state.queuedBytes += bytes;
    if (state.queuedFrames > 64 || state.queuedBytes > MAX_BYTES) {
      this.drop(state.grant);
      return;
    }
    state[direction] = state[direction].then(async () => {
      try {
        if (this.active(state.grant)) await run();
      } catch {
        this.drop(state.grant);
      } finally {
        state.queuedFrames--;
        state.queuedBytes -= bytes;
      }
    });
  }
  private forward(peer: ServerWebSocket<Peer>, forwarded: string): void {
    const state = peer.data;
    if (state.upstream?.readyState === WebSocket.OPEN) {
      if (state.upstream.bufferedAmount > MAX_BYTES)
        throw new Error("Native attachment is congested");
      state.upstream.send(forwarded);
    } else {
      if (
        state.queued.length >= 64 ||
        state.queued.reduce((sum, text) => sum + text.length, forwarded.length) > MAX_BYTES
      )
        throw new Error("Attachment startup queue full");
      state.queued.push(forwarded);
    }
  }
}
