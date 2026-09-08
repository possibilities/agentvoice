import { expect, test } from "bun:test";
import type { HostAudio } from "../src/console/host.ts";
import type { ClientMediaMessage } from "../src/frontend/media-protocol.ts";
import { NativeClientMedia } from "../src/frontend/native-media.ts";
import type { PeerEvents } from "../src/frontend/native-peer.ts";

function harness(start = async () => {}) {
  const sent: ClientMediaMessage[] = [];
  const events: PeerEvents[] = [];
  const closed: number[] = [];
  const frames: number[] = [];
  let stops = 0;
  const audio: HostAudio = {
    micMuted: false,
    speakerMuted: false,
    start,
    async stop() {
      stops++;
    },
    attachRemote() {},
    detachRemote() {},
  };
  let capture: (frame: Buffer) => void = () => {};
  const media = new NativeClientMedia(
    {
      audio: (send) => {
        capture = send;
        return audio;
      },
      peer: (handlers) => {
        const index = events.push(handlers) - 1;
        return {
          async offer() {
            return `offer-${index}`;
          },
          async answer() {},
          send() {
            frames.push(index);
          },
          async close() {
            closed.push(index);
          },
        };
      },
    },
    (message) => sent.push(message),
  );
  return {
    media,
    audio,
    sent,
    events,
    closed,
    frames,
    capture: () => capture(Buffer.alloc(1)),
    stops: () => stops,
  };
}

test("native client owns one muted device and switches peers only when successor connects", async () => {
  const h = harness();
  try {
    expect(h.audio.micMuted).toBe(true);
    expect(h.audio.speakerMuted).toBe(true);
    await h.media.receive({ type: "prepare", sessionId: "first" });
    h.events[0]!.connected();
    h.capture();
    await h.media.receive({ type: "prepare", sessionId: "second" });
    h.capture();
    expect(h.closed).toEqual([]);
    h.events[1]!.connected();
    h.capture();
    expect(h.frames).toEqual([0, 0, 1]);
    expect(h.closed).toEqual([0]);
    const count = h.sent.length;
    h.events[0]!.failed();
    h.events[0]!.connected();
    expect(h.sent).toHaveLength(count);
    h.media.state({
      mic: { muted: false, effectiveMuted: false },
      speaker: { muted: false, effectiveMuted: true },
    });
    expect(h.audio.micMuted).toBe(false);
    expect(h.audio.speakerMuted).toBe(true);
  } finally {
    await h.media.stop();
  }
  expect(h.closed).toEqual([0, 1]);
  expect(h.stops()).toBe(1);
  await h.media.stop();
  expect(h.stops()).toBe(1);
});

test("native client closed during permission startup cannot publish a late offer", async () => {
  const opening = Promise.withResolvers<void>();
  const h = harness(() => opening.promise);
  const preparing = h.media.receive({ type: "prepare", sessionId: "first" });
  const closing = h.media.stop();
  opening.resolve();
  await Promise.all([preparing, closing]);
  expect(h.sent).toEqual([]);
  expect(h.stops()).toBe(1);
  expect(h.audio.micMuted).toBe(true);
});

test("client device failure is bounded and does not leak diagnostic contents", async () => {
  const h = harness(async () => {
    throw new Error("private device diagnostic");
  });
  await h.media.receive({ type: "prepare", sessionId: "first" });
  expect(h.sent).toEqual([
    { type: "failed", sessionId: "first", detail: "Unable to start client microphone or WebRTC" },
  ]);
  expect(h.closed).toEqual([0]);
  await h.media.stop();
});

test("media close retains the device for runtime restart, but cannot close a successor", async () => {
  const h = harness();
  try {
    await h.media.receive({ type: "prepare", sessionId: "first" });
    await h.media.receive({ type: "close", sessionId: "first" });
    expect(h.stops()).toBe(0);
    await h.media.receive({ type: "prepare", sessionId: "second" });
    await h.media.receive({ type: "close", sessionId: "first" });
    h.events[1]!.connected();
    expect(h.sent.at(-1)).toEqual({ type: "connected", sessionId: "second" });
  } finally {
    await h.media.stop();
  }
});
