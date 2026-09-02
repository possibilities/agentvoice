import { afterEach, describe, expect, test } from "bun:test";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import {
  type TransportSignal,
  type VoicePhase,
  VoiceTransport,
} from "../src/tui/voice-transport.ts";

const OPUS = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48_000, channels: 2 });

/** A loopback voice agent: answers each offer with a peer that sends nothing. */
class LoopbackSignal implements TransportSignal {
  readonly peers: RTCPeerConnection[] = [];
  starts = 0;
  stops = 0;
  failNext = false;

  async start(offerSdp: string): Promise<string> {
    this.starts++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("thread/realtime/error: boom");
    }
    const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
    this.peers.push(pc);
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription!.sdp;
  }

  async stop(): Promise<void> {
    this.stops++;
    for (const pc of this.peers.splice(0)) await pc.close().catch(() => {});
  }
}

const transports: VoiceTransport[] = [];
const signals: LoopbackSignal[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()));
  await Promise.all(signals.splice(0).map((signal) => signal.stop()));
});

function build(signal: LoopbackSignal, overrides: { retryMs?: number } = {}) {
  const phases: VoicePhase[] = [];
  const feed: string[] = [];
  const transport = new VoiceTransport({
    signal,
    onPhase: (phase) => phases.push(phase),
    onRemoteTrack: () => {},
    onOaiEvent: () => {},
    onInfo: (line) => feed.push(line),
    onError: (line) => feed.push(line),
    negotiationTimeoutMs: 10_000,
    retryMs: overrides.retryMs ?? 50,
  });
  transports.push(transport);
  signals.push(signal);
  return { transport, phases, feed };
}

describe("voice transport over a loopback peer", () => {
  test("connects, redials sequentially, and reports an upstream close", async () => {
    const signal = new LoopbackSignal();
    const { transport, phases, feed } = build(signal, { retryMs: 60_000 });
    await transport.connect();
    expect(transport.currentPhase).toBe("live");
    expect(transport.liveForMs).not.toBeNull();
    expect(phases).toEqual(["negotiating", "live"]);
    expect(signal.starts).toBe(1);

    await transport.redial("manual");
    expect(transport.currentPhase).toBe("live");
    expect(signal.stops).toBeGreaterThanOrEqual(1);
    expect(signal.starts).toBe(2);
    expect(feed).toContain("redial (manual)");

    transport.handleClosed("transport_closed");
    expect(transport.currentPhase).toBe("idle");
    expect(feed).toContain("voice session closed: transport_closed");
  }, 30_000);

  test("a failed start is reported and retried", async () => {
    const signal = new LoopbackSignal();
    signal.failNext = true;
    const { transport, feed } = build(signal);
    await expect(transport.connect()).rejects.toThrow("boom");
    expect(feed.some((line) => line.includes("boom"))).toBe(true);
    const deadline = Date.now() + 15_000;
    while (transport.currentPhase !== "live" && Date.now() < deadline) await Bun.sleep(50);
    expect(transport.currentPhase).toBe("live");
    expect(signal.starts).toBe(2);
  }, 30_000);

  test("stop is terminal", async () => {
    const signal = new LoopbackSignal();
    const { transport } = build(signal);
    await transport.connect();
    await transport.stop();
    expect(transport.currentPhase).toBe("stopped");
    await expect(transport.connect()).rejects.toThrow("stopped");
  }, 30_000);
});
