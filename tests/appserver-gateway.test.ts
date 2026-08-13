import { describe, expect, test } from "bun:test";
import {
  AGENTVOICE_THREAD_IDENTITIES_METHOD,
  AGENTVOICE_VOICE_OBSERVATION_METHOD,
} from "../src/protocol.ts";
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

function fixture(
  immediate = true,
  onVoiceObservationChanged?: (observed: boolean) => void,
): {
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
    onVoiceObservationChanged,
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

  test("requests voice events while voice observers exist and relays only to them", async () => {
    const observation: boolean[] = [];
    const { gateway, upstreams } = fixture(true, (observed) => observation.push(observed));
    const first = new Peer();
    const second = new Peer();
    const envelopeOnly = new Peer();
    const native = new Peer();
    gateway.add(first, { observeVoice: true });
    gateway.add(second, { observeAgentVoice: true, observeVoice: true });
    gateway.add(envelopeOnly, { observeAgentVoice: true });
    gateway.add(native);
    await Promise.resolve();

    expect(gateway.observesVoiceEvents).toBe(true);
    expect(observation).toEqual([true]);
    const event = {
      kind: "event" as const,
      voiceSessionId: "voice-1",
      threadId: "thread-1",
      sequence: 1,
      observedAt: 1_234,
      payload: {
        type: "response.audio_transcript.delta",
        response_id: "response-1",
        delta: "raw",
        future: { untouched: true },
      },
    };
    gateway.voiceEvent(event);

    expect(JSON.parse(first.frames.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      method: AGENTVOICE_VOICE_OBSERVATION_METHOD,
      params: event,
    });
    expect(JSON.parse(second.frames.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      method: AGENTVOICE_VOICE_OBSERVATION_METHOD,
      params: event,
    });
    expect(envelopeOnly.frames).toEqual([]);
    expect(native.frames).toEqual([]);
    expect(upstreams.every((upstream) => upstream.sent.length === 0)).toBe(true);

    gateway.remove(first);
    expect(observation).toEqual([true]);
    gateway.remove(second);
    expect(gateway.observesVoiceEvents).toBe(false);
    expect(observation).toEqual([true, false]);
  });

  test("replays only the current lifecycle fact, never raw events or ended sessions", async () => {
    const { gateway } = fixture();
    const starting = {
      kind: "lifecycle" as const,
      voiceSessionId: "voice-1",
      threadId: "thread-1",
      state: "starting" as const,
      observedAt: 100,
    };
    gateway.voiceLifecycle(starting);
    gateway.voiceEvent({
      kind: "event",
      voiceSessionId: "voice-1",
      threadId: "thread-1",
      sequence: 1,
      observedAt: 101,
      payload: { type: "session.created" },
    });

    const first = new Peer();
    gateway.add(first, { observeVoice: true });
    await Promise.resolve();
    expect(first.frames.map((frame) => JSON.parse(frame).params)).toEqual([starting]);

    const active = { ...starting, state: "active" as const, observedAt: 102 };
    gateway.voiceLifecycle(active);
    const second = new Peer();
    gateway.add(second, { observeVoice: true });
    await Promise.resolve();
    expect(second.frames.map((frame) => JSON.parse(frame).params)).toEqual([active]);

    gateway.voiceLifecycle({
      ...active,
      state: "ended",
      observedAt: 103,
      reason: "upstream-closed",
    });
    const afterEnd = new Peer();
    gateway.add(afterEnd, { observeVoice: true });
    await Promise.resolve();
    expect(afterEnd.frames).toEqual([]);
  });

  test("relays explicit gaps with their complete session identity", async () => {
    const { gateway } = fixture();
    const observer = new Peer();
    gateway.add(observer, { observeVoice: true });
    await Promise.resolve();
    const gap = {
      kind: "gap" as const,
      voiceSessionId: "voice-1",
      threadId: "thread-1",
      fromSequence: 4,
      toSequence: 8,
      dropped: 5,
      observedAt: 1_234,
    };
    gateway.voiceGap(gap);
    expect(JSON.parse(observer.frames.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      method: AGENTVOICE_VOICE_OBSERVATION_METHOD,
      params: gap,
    });
  });

  test("replays and updates AgentVoice-owned thread identities only for observers", async () => {
    const { gateway } = fixture();
    gateway.replaceThreadIdentities([{ threadId: "root", role: "orchestrator" }]);
    const observer = new Peer();
    const native = new Peer();
    gateway.add(observer, { observeAgentVoice: true });
    gateway.add(native);
    await Promise.resolve();

    expect(JSON.parse(observer.frames.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      method: AGENTVOICE_THREAD_IDENTITIES_METHOD,
      params: { data: [{ threadId: "root", role: "orchestrator" }] },
    });
    expect(native.frames).toEqual([]);

    gateway.setThreadIdentity("worker", "worker");
    expect(JSON.parse(observer.frames.at(-1)!).params.data).toEqual([
      { threadId: "root", role: "orchestrator" },
      { threadId: "worker", role: "worker" },
    ]);
    gateway.removeThreadIdentity("worker");
    expect(JSON.parse(observer.frames.at(-1)!).params.data).toEqual([
      { threadId: "root", role: "orchestrator" },
    ]);
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
