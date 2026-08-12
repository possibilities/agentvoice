import { describe, expect, test } from "bun:test";
import {
  AppServerGateway,
  type GatewayPeer,
  type GatewayUpstream,
  type GatewayUpstreamCallbacks,
} from "../src/server/appserver-gateway.ts";

class Peer implements GatewayPeer {
  readonly readyState = 1;
  readonly frames: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string): void {
    this.frames.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

class Upstream implements GatewayUpstream {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  resolveConnect: (() => void) | null = null;
  rejectConnect: ((error: Error) => void) | null = null;
  readonly connected: Promise<void>;
  constructor(
    readonly callbacks: GatewayUpstreamCallbacks,
    immediate = true,
  ) {
    this.connected = immediate
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          this.resolveConnect = resolve;
          this.rejectConnect = reject;
        });
  }
  connect(): Promise<void> {
    return this.connected;
  }
  sendText(text: string): void {
    this.sent.push(text);
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

function fixture(immediate = true): {
  gateway: AppServerGateway;
  upstreams: Upstream[];
} {
  const upstreams: Upstream[] = [];
  const gateway = new AppServerGateway({
    connect(_socketPath, callbacks) {
      const upstream = new Upstream(callbacks, immediate);
      upstreams.push(upstream);
      return upstream;
    },
  });
  gateway.setAppServer({ alive: true, socketPath: "/private/app-server.sock" });
  return { gateway, upstreams };
}

describe("AppServerGateway", () => {
  test("gives every peer a distinct native connection and preserves exact frames", async () => {
    const { gateway, upstreams } = fixture();
    const first = new Peer();
    const second = new Peer();
    gateway.add(first);
    gateway.add(second);
    await Promise.resolve();

    const firstFrame = '{"jsonrpc":"2.0","id":"same","method":"thread/start","params":{"x":1}}';
    const secondFrame = '{"jsonrpc":"2.0","id":"same","method":"thread/start","params":{"x":2}}';
    gateway.handle(first, firstFrame);
    gateway.handle(second, secondFrame);
    expect(upstreams).toHaveLength(2);
    expect(upstreams[0]?.sent).toEqual([firstFrame]);
    expect(upstreams[1]?.sent).toEqual([secondFrame]);

    const response = '{"id":"same","result":{"raw":true}}';
    upstreams[0]?.callbacks.onText(response);
    expect(first.frames).toEqual([response]);
    expect(second.frames).toEqual([]);
  });

  test("forwards initialization and connection-scoped methods without interpretation", async () => {
    const { gateway, upstreams } = fixture();
    const peer = new Peer();
    gateway.add(peer, { observeAgentVoice: true });
    await Promise.resolve();

    const initialize = '{"id":1,"method":"initialize","params":{"capabilities":{"future":true}}}';
    const unsubscribe = '{"id":2,"method":"thread/unsubscribe","params":{"threadId":"t"}}';
    gateway.handle(peer, initialize);
    gateway.handle(peer, unsubscribe);
    expect(upstreams[0]?.sent).toEqual([initialize, unsubscribe]);
  });

  test("queues frames during connection establishment with a bounded buffer", async () => {
    const { gateway, upstreams } = fixture(false);
    const peer = new Peer();
    gateway.add(peer, { observeAgentVoice: true });
    const first = '{"id":1,"method":"initialize"}';
    const second = '{"method":"initialized"}';
    gateway.handle(peer, first);
    gateway.handle(peer, second);
    expect(upstreams[0]?.sent).toEqual([]);

    upstreams[0]?.resolveConnect?.();
    await Promise.resolve();
    expect(upstreams[0]?.sent).toEqual([first, second]);
  });

  test("closing a downstream peer closes exactly its physical connection", async () => {
    const { gateway, upstreams } = fixture();
    const first = new Peer();
    const second = new Peer();
    gateway.add(first);
    gateway.add(second);
    await Promise.resolve();
    gateway.remove(first);

    expect(upstreams[0]?.closes).toEqual([{ code: 1000, reason: "gateway peer disconnected" }]);
    expect(upstreams[1]?.closes).toEqual([]);
  });

  test("fans out only additive AgentVoice owning-connection envelopes", async () => {
    const { gateway, upstreams } = fixture();
    const peer = new Peer();
    gateway.add(peer, { observeAgentVoice: true });
    await Promise.resolve();
    const payload = { method: "turn/started", params: { threadId: "t" } };
    gateway.frame("fromAppServer", "appServer", payload);

    expect(JSON.parse(peer.frames[0]!)).toEqual({
      jsonrpc: "2.0",
      method: "agentvoice/frame",
      params: { direction: "fromAppServer", owner: "appServer", payload },
    });
    expect(upstreams[0]?.sent).toEqual([]);
  });

  test("keeps the default gateway stream exactly native", async () => {
    const { gateway } = fixture();
    const peer = new Peer();
    gateway.add(peer);
    await Promise.resolve();
    gateway.frame("fromAppServer", "appServer", {
      method: "turn/started",
      params: { threadId: "t" },
    });
    expect(peer.frames).toEqual([]);
  });

  test("rejects admission while unavailable and disconnects peers on child replacement", async () => {
    const unavailable = new AppServerGateway();
    const refused = new Peer();
    unavailable.add(refused);
    expect(refused.closes).toEqual([
      { code: 1013, reason: "AgentVoice app-server is not running" },
    ]);

    const { gateway, upstreams } = fixture();
    const connected = new Peer();
    gateway.add(connected);
    await Promise.resolve();
    gateway.setAppServer(null);
    expect(upstreams[0]?.closes).toEqual([{ code: 1012, reason: "AgentVoice app-server changed" }]);
    expect(connected.closes).toEqual([{ code: 1012, reason: "AgentVoice app-server changed" }]);
  });
});
