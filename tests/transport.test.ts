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
    return { onmessage: null };
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

function harness() {
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
    onOaiEvent() {},
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
      expect(h.errors.at(-1)).toBe(`${reason} — retries paused; press r to redial`);
      expect(h.peers.every((peer) => peer.closed)).toBe(true);
      const notices = h.errors.length;
      h.transport.handleReady(ready);
      await tick();
      expect(h.starts).toHaveLength(3);
      expect(h.errors).toHaveLength(notices);

      h.transport.redial("manual");
      await tick();
      expect(h.starts).toHaveLength(4);
      h.peers.at(-1)!.onState("connected");
      expect(h.transport.currentPhase).toBe("live");
    } finally {
      await h.stop();
    }
  });

  test("manual redial cancels a scheduled retry, and quit cancels the next one", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      await tick();
      h.fail("temporary failure");
      h.transport.redial("manual");
      await tick();
      expect(h.starts).toHaveLength(2);
      h.peers.at(-1)!.onState("connected");
      await afterRetry();
      expect(h.starts).toHaveLength(2);
      h.fail("another failure");
      await h.stop();
      await afterRetry();
      expect(h.starts).toHaveLength(2);
      expect(h.transport.currentPhase).toBe("stopped");
      expect(h.peers.every((peer) => peer.closed)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  test("Fresh cancels the old retry and waits for the new conversation", async () => {
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
