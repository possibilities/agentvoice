import { describe, expect, test } from "bun:test";
import {
  barString,
  FRAME_SAMPLES,
  floatToS16,
  formatClock,
  levelFromDb,
  rmsDbFloat,
  rmsDbS16,
  SAMPLE_RATE,
  shortId,
  sparkline,
} from "../src/client/dsp.ts";
import { OAI_EVENT_RELAY_BACKPRESSURE_LIMIT, VoiceTransport } from "../src/client/transport.ts";
import { voiceActivityHeight } from "../src/client/ui.ts";

describe("client vertical layout", () => {
  test("voice activity keeps one field at both responsive widths", () => {
    expect(voiceActivityHeight(100)).toBe(9);
    expect(voiceActivityHeight(68)).toBe(9);
    expect(voiceActivityHeight(67)).toBe(9);
    expect(voiceActivityHeight(40)).toBe(9);
  });
});

describe("frame constants", () => {
  test("one frame is 20ms at the session rate", () => {
    expect(FRAME_SAMPLES / SAMPLE_RATE).toBeCloseTo(0.02);
  });
});

describe("floatToS16", () => {
  test("converts and clamps", () => {
    const out = floatToS16(new Float32Array([0, 0.5, 1, -1, 2, -2]));
    expect(out.length).toBe(12);
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(2)).toBe(16384);
    expect(out.readInt16LE(4)).toBe(32767);
    expect(out.readInt16LE(6)).toBe(-32767);
    expect(out.readInt16LE(8)).toBe(32767);
    expect(out.readInt16LE(10)).toBe(-32767);
  });
});

describe("rms", () => {
  test("silence is -Infinity in both domains", () => {
    expect(rmsDbFloat(new Float32Array(100))).toBe(-Infinity);
    expect(rmsDbS16(Buffer.alloc(200))).toBe(-Infinity);
    expect(rmsDbFloat(new Float32Array(0))).toBe(-Infinity);
  });

  test("full-scale square wave is ~0 dBFS, half scale ~-6 dB", () => {
    const full = new Float32Array(96).fill(1);
    expect(rmsDbFloat(full)).toBeCloseTo(0, 3);
    const half = new Float32Array(96).fill(0.5);
    expect(rmsDbFloat(half)).toBeCloseTo(-6.02, 1);
    const s16 = floatToS16(half);
    expect(rmsDbS16(s16)).toBeCloseTo(-6.02, 1);
  });
});

describe("levelFromDb", () => {
  test("maps the floor..0 range onto 0..1 and clamps", () => {
    expect(levelFromDb(-Infinity)).toBe(0);
    expect(levelFromDb(-60)).toBe(0);
    expect(levelFromDb(-30)).toBeCloseTo(0.5);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(10)).toBe(1);
    expect(levelFromDb(-90)).toBe(0);
  });
});

describe("meter rendering", () => {
  test("barString is always exactly width chars", () => {
    for (const level of [0, 0.01, 0.33, 0.5, 0.99, 1]) {
      expect(barString(level, 20).length).toBe(20);
    }
    expect(barString(0, 10)).toBe(" ".repeat(10));
    expect(barString(1, 10)).toBe("█".repeat(10));
  });

  test("barString grows monotonically", () => {
    let previous = "";
    for (let level = 0; level <= 1.0001; level += 0.05) {
      const bar = barString(level, 16);
      const fill = (bar.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length;
      const previousFill = (previous.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length;
      expect(fill).toBeGreaterThanOrEqual(previousFill);
      previous = bar;
    }
  });

  test("sparkline right-aligns and windows history", () => {
    expect(sparkline([], 8)).toBe(" ".repeat(8));
    expect(sparkline([1], 4)).toBe("   █");
    const line = sparkline([0, 0.25, 0.5, 0.75, 1], 3);
    expect(line.length).toBe(3);
    expect(line.at(-1)).toBe("█");
  });
});

describe("formatClock", () => {
  test("renders mm:ss and grows to hours", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_000)).toBe("59:59");
    expect(formatClock(3_661_000)).toBe("1:01:01");
    expect(formatClock(-5_000)).toBe("00:00");
  });
});

describe("shortId", () => {
  test("truncates long ids only", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("012345678")).toBe("012345678");
    expect(shortId("0123456789abcdef")).toBe("01234567…");
  });
});

describe("voice transport server messages", () => {
  test("routes a config change to the existing make-before-break redial", async () => {
    const reasons: string[] = [];
    const transport = new VoiceTransport({
      url: "ws://127.0.0.1/ws",
      onPhase() {},
      onReady() {},
      onRemoteTrack() {},
      onOaiEvent() {},
      onInfo() {},
      onError() {},
    });
    transport.redial = (reason) => reasons.push(reason);

    await (
      transport as unknown as { handleServerMessage(text: string): Promise<void> }
    ).handleServerMessage(JSON.stringify({ type: "redial", reason: "voice-name-changed" }));

    expect(reasons).toEqual(["voice-name-changed"]);
  });

  test("relays parsed oai-events only while a voice observer is present", async () => {
    const received: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const transport = new VoiceTransport({
      url: "ws://127.0.0.1/ws",
      onPhase() {},
      onReady() {},
      onRemoteTrack() {},
      onOaiEvent(event) {
        received.push(event);
      },
      onInfo() {},
      onError() {},
    });
    const internals = transport as unknown as {
      ws: { readyState: number; bufferedAmount: number; send(text: string): void };
      handleServerMessage(text: string): Promise<void>;
      handleOaiEventText(session: TestPeerSession, text: string): void;
    };
    internals.ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(text) {
        sent.push(text);
      },
    };
    const session = testPeerSession("voice-1");

    const unobserved = { type: "response.audio_transcript.delta", delta: "hello" };
    internals.handleOaiEventText(session, JSON.stringify(unobserved));
    expect(received).toEqual([unobserved]);
    expect(sent).toEqual([]);

    await internals.handleServerMessage(
      JSON.stringify({ type: "observe-oai-events", enabled: true }),
    );
    const observed = {
      type: "response.done",
      response: { id: "response-1", output: [{ type: "message", content: [] }] },
      futureField: { untouched: [1, true, null] },
    };
    internals.handleOaiEventText(session, JSON.stringify(observed));
    expect(received.at(-1)).toEqual(observed);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "oai-event",
      voiceSessionId: "voice-1",
      sequence: 1,
      observedAt: expect.any(Number),
      payload: observed,
    });

    await internals.handleServerMessage(
      JSON.stringify({ type: "observe-oai-events", enabled: false }),
    );
    internals.handleOaiEventText(session, JSON.stringify({ type: "session.updated" }));
    expect(sent).toHaveLength(1);
  });

  test("coalesces dropped sequences under backpressure and reports the gap first", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport = new VoiceTransport({
      url: "ws://127.0.0.1/ws",
      onPhase() {},
      onReady() {},
      onRemoteTrack() {},
      onOaiEvent() {},
      onInfo() {},
      onError() {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: OAI_EVENT_RELAY_BACKPRESSURE_LIMIT + 1,
      send(text: string) {
        sent.push(JSON.parse(text));
      },
    };
    const session = testPeerSession("voice-backpressure");
    const internals = transport as unknown as {
      ws: typeof ws;
      handleServerMessage(text: string): Promise<void>;
      handleOaiEventText(session: TestPeerSession, text: string): void;
    };
    internals.ws = ws;
    await internals.handleServerMessage(
      JSON.stringify({ type: "observe-oai-events", enabled: true }),
    );

    internals.handleOaiEventText(session, JSON.stringify({ type: "one" }));
    internals.handleOaiEventText(session, JSON.stringify({ type: "two" }));
    expect(sent).toEqual([]);
    expect(session.pendingObservationGap).toEqual({
      fromSequence: 1,
      toSequence: 2,
      dropped: 2,
    });

    ws.bufferedAmount = 0;
    internals.handleOaiEventText(session, JSON.stringify({ type: "three" }));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      type: "oai-event-gap",
      voiceSessionId: "voice-backpressure",
      fromSequence: 1,
      toSequence: 2,
      dropped: 2,
      observedAt: expect.any(Number),
    });
    expect(sent[1]).toEqual({
      type: "oai-event",
      voiceSessionId: "voice-backpressure",
      sequence: 3,
      observedAt: expect.any(Number),
      payload: { type: "three" },
    });
  });

  test("retains a coalesced gap after its peer is replaced", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport = new VoiceTransport({
      url: "ws://127.0.0.1/ws",
      onPhase() {},
      onReady() {},
      onRemoteTrack() {},
      onOaiEvent() {},
      onInfo() {},
      onError() {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: OAI_EVENT_RELAY_BACKPRESSURE_LIMIT + 1,
      send(text: string) {
        sent.push(JSON.parse(text));
      },
    };
    const session = testPeerSession("voice-retired");
    session.pendingObservationGap = { fromSequence: 7, toSequence: 9, dropped: 3 };
    const internals = transport as unknown as {
      ws: typeof ws;
      handleServerMessage(text: string): Promise<void>;
      retireObservationGap(session: TestPeerSession): void;
      flushRetiredObservationGaps(socket: typeof ws): void;
    };
    internals.ws = ws;
    await internals.handleServerMessage(
      JSON.stringify({ type: "observe-oai-events", enabled: true }),
    );

    internals.retireObservationGap(session);
    expect(session.pendingObservationGap).toBeNull();
    ws.bufferedAmount = 0;
    internals.flushRetiredObservationGaps(ws);

    expect(sent).toEqual([
      {
        type: "oai-event-gap",
        voiceSessionId: "voice-retired",
        fromSequence: 7,
        toSequence: 9,
        dropped: 3,
        observedAt: expect.any(Number),
      },
    ]);
  });

  test("binds the answer identity before applying its SDP", async () => {
    const transport = new VoiceTransport({
      url: "ws://127.0.0.1/ws",
      onPhase() {},
      onReady() {},
      onRemoteTrack() {},
      onOaiEvent() {},
      onInfo() {},
      onError() {},
    });
    const session = testPeerSession(null);
    let identityDuringApply: string | null | undefined;
    session.pc = {
      async setRemoteDescription() {
        identityDuringApply = session.voiceSessionId;
      },
    };
    const internals = transport as unknown as {
      pending: TestPeerSession;
      handleServerMessage(text: string): Promise<void>;
    };
    internals.pending = session;
    await internals.handleServerMessage(
      JSON.stringify({ type: "answer", sdp: "answer-sdp", voiceSessionId: "voice-new" }),
    );
    expect(identityDuringApply).toBe("voice-new");
  });
});

interface TestPeerSession {
  pc: { setRemoteDescription?(description: { type: string; sdp: string }): Promise<void> };
  voiceSessionId: string | null;
  nextObservationSequence: number;
  pendingObservationGap: { fromSequence: number; toSequence: number; dropped: number } | null;
}

function testPeerSession(voiceSessionId: string | null): TestPeerSession {
  return {
    pc: {},
    voiceSessionId,
    nextObservationSequence: 1,
    pendingObservationGap: null,
  };
}
