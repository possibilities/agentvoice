import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { NativeEndpoint } from "../core/native-listener.ts";
import {
  type AttachmentIdentity,
  attachmentNotification,
  attachmentResult,
  object,
  validateAttachmentRequest,
} from "./policy.ts";

export type AttachmentTicket = AttachmentIdentity & { url: string; token: string; codex: string };
type Grant = {
  identity: AttachmentIdentity;
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
    { method: string; sequence: number; timer: ReturnType<typeof setTimeout> }
  >;
  initialized: boolean;
  initializing: boolean;
  unsubscribed: boolean;
  sequence: number;
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
          initializing: false,
          unsubscribed: false,
          sequence: 0,
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
        message: (peer, data) => this.message(peer, data),
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
    for (const peer of grant.peers) {
      for (const request of peer.data.pending.values()) clearTimeout(request.timer);
      peer.data.pending.clear();
      peer.data.upstream?.close();
      peer.close(
        code,
        code === 1000 ? "TUI disconnected" : "Attachment ended; run agentvoice attach again",
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
      if (!this.active(state.grant)) return;
      try {
        if (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES)
          throw new Error("Invalid native frame");
        const frame = object(JSON.parse(data));
        const id = frame["id"];
        const method = frame["method"];
        // The owner handles all native server requests. Never give the TUI a competing answer path.
        if (id !== undefined && method !== undefined) return;
        if (id !== undefined) {
          const request = state.pending.get(id as string | number);
          if (!request) throw new Error("Uncorrelated native response");
          state.pending.delete(id as string | number);
          clearTimeout(request.timer);
          if (!frame["error"]) {
            frame["result"] = attachmentResult(
              request.method,
              frame["result"],
              state.grant.identity,
            );
            if (request.method === "initialize") state.initialized = true;
            // Stock TUI /quit can close TCP without a WebSocket close handshake.
            if (request.method === "thread/unsubscribe")
              state.unsubscribed = request.sequence === state.sequence && state.pending.size === 0;
          }
        } else if (
          typeof method !== "string" ||
          !attachmentNotification(method, object(frame["params"] ?? {}), state.grant.identity)
        )
          return;
        peer.send(JSON.stringify(frame).replaceAll(this.native.token, "[redacted]"));
      } catch {
        this.drop(state.grant);
      }
    });
  }
  private message(peer: ServerWebSocket<Peer>, data: string | Buffer): void {
    const state = peer.data;
    if (!this.active(state.grant)) return;
    state.sequence++;
    state.unsubscribed = false;
    let id: string | number | undefined;
    let registered = false;
    let method = "invalid frame";
    try {
      if (state.watch || typeof data !== "string") throw new Error("Invalid attachment frame");
      const frame = object(JSON.parse(data));
      if (Object.keys(frame).some((key) => !["id", "method", "params", "jsonrpc"].includes(key)))
        throw new Error("Unsupported client frame");
      if (typeof frame["id"] === "string" || typeof frame["id"] === "number") id = frame["id"];
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
        validateAttachmentRequest(method, params, state.grant.identity);
        frame["params"] = params;
        if (method === "initialize") state.initializing = true;
        if (state.pending.size >= 64) throw new Error("Too many attachment requests");
        state.pending.set(id, {
          method,
          sequence: state.sequence,
          timer: setTimeout(() => this.drop(state.grant), 30_000),
        });
        registered = true;
      }
      if (!this.active(state.grant)) return;
      const forwarded = JSON.stringify(frame);
      this.trace?.(method, "forwarded");
      if (state.upstream?.readyState === WebSocket.OPEN) {
        if (state.upstream.bufferedAmount > MAX_BYTES)
          throw new Error("Native attachment is congested");
        state.upstream.send(forwarded);
      } else {
        if (
          state.queued.length >= 64 ||
          state.queued.reduce((sum, text) => sum + text.length, data.length) > MAX_BYTES
        )
          throw new Error("Attachment startup queue full");
        state.queued.push(forwarded);
      }
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
}
