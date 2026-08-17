import { describe, expect, test } from "bun:test";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
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
    expect(
      parseRemoteState(
        '{"type":"state","protocol":5,"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"effectiveMuted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":6,"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"effectiveMuted":false,"db":1},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":6,"sequence":1,"phase":"live","liveForMs":-1,"mic":{"muted":false,"effectiveMuted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":6,"sequence":1,"phase":"live","liveForMs":0,"mic":{"muted":false,"db":null},"speaker":{"muted":false,"effectiveMuted":false,"db":null}}',
      ),
    ).toBeNull();
  });
});
