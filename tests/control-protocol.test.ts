import { describe, expect, test } from "bun:test";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlState,
  encodeControlFrame,
  parseControlCommand,
  parseServerFrame,
  type ServerFrame,
  type VoiceStateBody,
} from "../src/core/control-protocol.ts";

const VOICE_BODY: VoiceStateBody = {
  phase: "live",
  liveForMs: 1234,
  mic: { muted: true, effectiveMuted: false, db: -18.5 },
  speaker: { muted: false, effectiveMuted: false, db: null },
};

function roundTripCommand(command: ControlCommand): ControlCommand | null {
  return parseControlCommand(encodeControlFrame(command).trim());
}

function roundTripFrame(frame: ServerFrame): ServerFrame | null {
  return parseServerFrame(encodeControlFrame(frame).trim());
}

describe("peer → server commands", () => {
  test("hello round-trips both roles, with and without a token", () => {
    expect(
      roundTripCommand({ type: "hello", protocol: CONTROL_PROTOCOL_VERSION, role: "voice" }),
    ).toEqual({ type: "hello", protocol: CONTROL_PROTOCOL_VERSION, role: "voice" });
    expect(
      roundTripCommand({
        type: "hello",
        protocol: CONTROL_PROTOCOL_VERSION,
        role: "ui",
        token: "secret",
      }),
    ).toEqual({ type: "hello", protocol: CONTROL_PROTOCOL_VERSION, role: "ui", token: "secret" });
  });

  test("hello without a valid role is refused", () => {
    expect(parseControlCommand(`{"type":"hello","protocol":8}`)).toBeNull();
    expect(parseControlCommand(`{"type":"hello","protocol":8,"role":"speaker"}`)).toBeNull();
  });

  test("audio commands round-trip", () => {
    expect(roundTripCommand({ type: "set-muted", target: "mic", muted: true })).toEqual({
      type: "set-muted",
      target: "mic",
      muted: true,
    });
    expect(roundTripCommand({ type: "hold-unmuted", target: "mic", input: "space" })).toEqual({
      type: "hold-unmuted",
      target: "mic",
      input: "space",
    });
    expect(
      roundTripCommand({ type: "release-unmuted", target: "speaker", input: "key", commit: true }),
    ).toEqual({ type: "release-unmuted", target: "speaker", input: "key", commit: true });
  });

  test("voice frames round-trip and refuse an empty offer", () => {
    expect(roundTripCommand({ type: "offer", sdp: "v=0…" })).toEqual({
      type: "offer",
      sdp: "v=0…",
    });
    expect(parseControlCommand(`{"type":"offer","sdp":""}`)).toBeNull();
    expect(roundTripCommand({ type: "voice-state", voice: VOICE_BODY })).toEqual({
      type: "voice-state",
      voice: VOICE_BODY,
    });
  });

  test("a positive db is rejected — dBFS never exceeds zero", () => {
    const body = { ...VOICE_BODY, mic: { muted: false, effectiveMuted: false, db: 3 } };
    expect(parseControlCommand(JSON.stringify({ type: "voice-state", voice: body }))).toBeNull();
  });

  test("garbage and non-object lines are null", () => {
    expect(parseControlCommand("not json")).toBeNull();
    expect(parseControlCommand(`"a string"`)).toBeNull();
    expect(parseControlCommand(`{"type":"unknown"}`)).toBeNull();
  });
});

describe("server → peer frames", () => {
  test("state round-trips with and without a voice peer", () => {
    const populated: ControlState = {
      type: "state",
      protocol: CONTROL_PROTOCOL_VERSION,
      sequence: 7,
      voice: VOICE_BODY,
    };
    expect(roundTripFrame(populated)).toEqual(populated);
    const empty: ControlState = {
      type: "state",
      protocol: CONTROL_PROTOCOL_VERSION,
      sequence: 8,
      voice: null,
    };
    expect(roundTripFrame(empty)).toEqual(empty);
  });

  test("state from another protocol version is refused", () => {
    expect(parseServerFrame(`{"type":"state","protocol":7,"sequence":0,"voice":null}`)).toBeNull();
  });

  test("session frames round-trip", () => {
    const info = {
      threadId: "thr_1",
      workspace: "/home/user",
      model: null,
      effort: "high",
      voiceModel: null,
      voice: "cedar",
      prompts: ["VOICE.md"],
    };
    expect(roundTripFrame({ type: "session-ready", info })).toEqual({
      type: "session-ready",
      info,
    });
    expect(roundTripFrame({ type: "session-answer", sdp: "v=0…" })).toEqual({
      type: "session-answer",
      sdp: "v=0…",
    });
    expect(roundTripFrame({ type: "session-closed" })).toEqual({ type: "session-closed" });
    expect(roundTripFrame({ type: "session-closed", reason: "transport_closed" })).toEqual({
      type: "session-closed",
      reason: "transport_closed",
    });
    expect(roundTripFrame({ type: "session-redial", reason: "renewal" })).toEqual({
      type: "session-redial",
      reason: "renewal",
    });
    expect(roundTripFrame({ type: "session-error", message: "boom", fatal: true })).toEqual({
      type: "session-error",
      message: "boom",
      fatal: true,
    });
  });

  test("a session-ready with a malformed info is refused whole", () => {
    expect(
      parseServerFrame(`{"type":"session-ready","info":{"threadId":"t","workspace":1}}`),
    ).toBeNull();
    expect(
      parseServerFrame(
        `{"type":"session-ready","info":{"threadId":"t","workspace":"w","model":5,"effort":null,"voiceModel":null,"voice":null,"prompts":[]}}`,
      ),
    ).toBeNull();
  });

  test("routing frames round-trip", () => {
    expect(roundTripFrame({ type: "route-set-muted", target: "speaker", muted: false })).toEqual({
      type: "route-set-muted",
      target: "speaker",
      muted: false,
    });
    expect(roundTripFrame({ type: "route-hold", target: "mic", source: "remote:3:key" })).toEqual({
      type: "route-hold",
      target: "mic",
      source: "remote:3:key",
    });
    expect(
      roundTripFrame({
        type: "route-release",
        target: "mic",
        source: "remote:3:key",
        commit: true,
      }),
    ).toEqual({ type: "route-release", target: "mic", source: "remote:3:key", commit: true });
    expect(roundTripFrame({ type: "route-redial" })).toEqual({ type: "route-redial" });
    expect(roundTripFrame({ type: "voice-superseded" })).toEqual({ type: "voice-superseded" });
  });
});
