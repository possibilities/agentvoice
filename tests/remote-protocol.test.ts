import { describe, expect, test } from "bun:test";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
  parseRemoteReject,
  parseRemoteState,
  REMOTE_PROTOCOL_VERSION,
} from "../src/console/remote-protocol.ts";

describe("remote protocol", () => {
  test("round-trips mirrored signal state", () => {
    const state = {
      type: "state" as const,
      protocol: REMOTE_PROTOCOL_VERSION,
      sequence: 4,
      phase: "live" as const,
      liveForMs: 4_250,
      mic: { muted: false, effectiveMuted: true, db: null },
      speaker: { muted: true, effectiveMuted: false, db: -24.5 },
    } as const;
    expect(parseRemoteState(encodeRemoteMessage(state).trim())).toEqual(state);
  });

  test("accepts shared TUI actions", () => {
    expect(parseRemoteCommand('{"type":"set-muted","target":"mic","muted":true}')).toEqual({
      type: "set-muted",
      target: "mic",
      muted: true,
    });
    expect(
      parseRemoteCommand('{"type":"hold-unmuted","target":"speaker","input":"pointer"}'),
    ).toEqual({ type: "hold-unmuted", target: "speaker", input: "pointer" });
    expect(
      parseRemoteCommand(
        '{"type":"release-unmuted","target":"speaker","input":"pointer","commit":false}',
      ),
    ).toEqual({ type: "release-unmuted", target: "speaker", input: "pointer", commit: false });
    expect(parseRemoteCommand('{"type":"redial"}')).toEqual({ type: "redial" });
    expect(parseRemoteCommand('{"type":"fresh"}')).toEqual({ type: "fresh" });
    expect(parseRemoteCommand('{"type":"toggle","target":"mic"}')).toBeNull();
    expect(parseRemoteCommand('{"type":"set-muted","target":"server","muted":true}')).toBeNull();
    expect(
      parseRemoteCommand('{"type":"hold-unmuted","target":"mic","input":"unknown"}'),
    ).toBeNull();
    expect(
      parseRemoteCommand('{"type":"hold-muted","target":"mic","input":"pointer","muted":true}'),
    ).toBeNull();
    expect(parseRemoteCommand('{"type":"push-to-talk","active":true}')).toBeNull();
    expect(parseRemoteCommand("nope")).toBeNull();
  });

  test("rejects incompatible and out-of-range state", () => {
    // Interpolated, not literal: a version bump must not silently turn these
    // into version-mismatch cases and stop testing what they name.
    const current = REMOTE_PROTOCOL_VERSION;
    expect(
      parseRemoteState(
        `{"type":"state","protocol":${current - 1},"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"effectiveMuted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}`,
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        `{"type":"state","protocol":${current},"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"effectiveMuted":false,"db":1},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}`,
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        `{"type":"state","protocol":${current},"sequence":1,"phase":"live","liveForMs":-1,"mic":{"muted":false,"effectiveMuted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}`,
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        `{"type":"state","protocol":${current},"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}`,
      ),
    ).toBeNull();
  });

  test("carries the network attachment's hello, beat, and refusal", () => {
    // hello's protocol is a plain number so a mismatched Remote console can be
    // told its version rather than dropped without a word.
    expect(parseRemoteCommand('{"type":"hello","protocol":1,"token":"abc"}')).toEqual({
      type: "hello",
      protocol: 1,
      token: "abc",
    });
    expect(parseRemoteCommand('{"type":"hello","protocol":7}')).toBeNull();
    expect(parseRemoteCommand('{"type":"hello","token":"abc"}')).toBeNull();
    expect(parseRemoteCommand('{"type":"hello","protocol":"7","token":"abc"}')).toBeNull();
    expect(parseRemoteCommand('{"type":"ping"}')).toEqual({ type: "ping" });

    const reject = { type: "reject" as const, reason: "token rejected" };
    expect(parseRemoteReject(encodeRemoteMessage(reject).trim())).toEqual(reject);
    expect(parseRemoteReject('{"type":"reject"}')).toBeNull();
    expect(parseRemoteReject('{"type":"state"}')).toBeNull();
    // The two directions never collide: a refusal is not a command, and a
    // command is not a refusal.
    expect(parseRemoteCommand(encodeRemoteMessage(reject).trim())).toBeNull();
    expect(parseRemoteReject('{"type":"ping"}')).toBeNull();
  });
});
