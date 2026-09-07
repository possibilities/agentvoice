import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { type ReadyInfo, VoiceTransport } from "../src/console/transport.ts";
import { VoiceSessionManager } from "../src/core/session.ts";

const ready: ReadyInfo = {
  threadId: "test-thread",
  workspace: "/test",
  model: null,
  effort: null,
  conversationMode: "started",
  voiceVersion: null,
  prompts: [],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const afterRetry = () => new Promise((resolve) => setTimeout(resolve, 1_100));

class FakePeer {
  dataChannel = { onmessage: undefined as ((event: unknown) => void) | undefined };
  closed = false;
  localDescription = { sdp: "fake-offer" };
  onState: (state: string) => void = () => {};
  connectionStateChange = {
    subscribe: (listener: (state: string) => void) => {
      this.onState = listener;
    },
  };
  onTrack = { subscribe() {} };
  addTransceiver() {}
  createDataChannel() {
    return this.dataChannel;
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async close() {
    this.closed = true;
    this.onState("closed");
  }
}

function harness(options: { onOaiEvent?: (event: Record<string, unknown>) => void } = {}) {
  const peers: FakePeer[] = [];
  const starts: string[] = [];
  const errors: string[] = [];
  const transport = new VoiceTransport({
    signal: { offer: (sdp) => manager.handleOffer(sdp) },
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      // Only the peer boundary is fake; session signaling and timers are real.
      return peer as unknown as RTCPeerConnection;
    },
    onPhase() {},
    onReady() {},
    onRemoteTrack() {},
    onOaiEvent: options.onOaiEvent,
    onInfo() {},
    onError: (line) => errors.push(line),
  });
  const manager = new VoiceSessionManager({
    sendAnswer: (sdp) => void transport.handleAnswer(sdp),
    sendClosed: (reason) => transport.handleClosed(reason),
    sendFailed: (reason) => transport.handleError(reason, true),
    sendReady: () => transport.handleReady(ready),
    startRealtime: async (id) => {
      starts.push(id);
    },
    stopRealtime: async () => {},
  });
  return {
    transport,
    peers,
    starts,
    errors,
    fail(reason: string) {
      manager.handleNotification("thread/realtime/started", {
        realtimeSessionId: starts.at(-1),
      });
      manager.handleNotification("thread/realtime/error", { message: reason });
      manager.handleNotification("thread/realtime/closed", { reason: "error" });
    },
    async stop() {
      await transport.stop();
      await manager.shutdown();
    },
  };
}

describe("voice transport diagnostics", () => {
  test("keeps the data channel but does not decode events without a consumer", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      await tick();
      expect(h.starts).toHaveLength(1);
      h.peers[0]!.dataChannel.onmessage!({
        get data() {
          throw new Error("unused data must not be decoded");
        },
      });
    } finally {
      await h.stop();
    }
  });

  test("delivers decoded data-channel events when diagnostics have a consumer", async () => {
    const events: Record<string, unknown>[] = [];
    const h = harness({ onOaiEvent: (event) => events.push(event) });
    try {
      h.transport.handleReady(ready);
      await tick();
      h.peers[0]!.dataChannel.onmessage!({ data: '{"type":"session.created"}' });
      expect(events).toEqual([{ type: "session.created" }]);
    } finally {
      await h.stop();
    }
  });
});

describe("voice transport retries", () => {
  test("native failure/ready preserves the cause, delays retries and stops at three", async () => {
    const h = harness();
    const reason = "AVAS requires OpenAI-Alpha: quicksilver=v2.";
    try {
      h.transport.handleReady(ready);
      await tick();
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(h.starts).toHaveLength(attempt);
        // Exercise both negotiation failure and failure just after connecting.
        if (attempt === 2) h.peers.at(-1)!.onState("connected");
        h.fail(reason);
        await tick();
        expect(h.starts).toHaveLength(attempt);
        expect(h.errors.at(-1)).toContain(reason);
        await afterRetry();
      }
      expect(h.starts).toHaveLength(3);
      expect(h.transport.currentPhase).toBe("failed");
      expect(h.errors.at(-1)).toBe(
        `${reason} — retries paused; close the frontend and start a new call`,
      );
      expect(h.peers.every((peer) => peer.closed)).toBe(true);
      const notices = h.errors.length;
      h.transport.handleReady(ready);
      await tick();
      expect(h.starts).toHaveLength(3);
      expect(h.errors).toHaveLength(notices);
    } finally {
      await h.stop();
    }
  });

  test("quit cancels a scheduled retry", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      await tick();
      h.fail("temporary failure");
      await h.stop();
      await afterRetry();
      expect(h.starts).toHaveLength(1);
      expect(h.transport.currentPhase).toBe("stopped");
      expect(h.peers.every((peer) => peer.closed)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  test("signal loss cancels retry until readiness returns", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      await tick();
      h.fail("old conversation failure");
      h.transport.handleSignalLost();
      await afterRetry();
      expect(h.starts).toHaveLength(1);
      h.transport.handleReady({ ...ready, threadId: "fresh-thread" });
      await tick();
      expect(h.starts).toHaveLength(2);
      h.peers.at(-1)!.onState("connected");
      expect(h.transport.currentPhase).toBe("live");
    } finally {
      await h.stop();
    }
  });
});
