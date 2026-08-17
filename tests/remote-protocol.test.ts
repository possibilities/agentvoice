import { describe, expect, test } from "bun:test";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
  parseRemoteState,
  REMOTE_PROTOCOL_VERSION,
} from "../src/console/remote-protocol.ts";

describe("remote protocol", () => {
  test("round-trips compact state metadata", () => {
    const state = {
      type: "state" as const,
      protocol: REMOTE_PROTOCOL_VERSION,
      sequence: 4,
      phase: "live" as const,
      mic: { muted: false, effectiveMuted: true, level: 0.75 },
      speaker: { muted: true, effectiveMuted: false, level: 0.25 },
    } as const;
    expect(parseRemoteState(encodeRemoteMessage(state).trim())).toEqual(state);
  });

  test("accepts persistent assignments and source-owned unmute holds", () => {
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
        '{"type":"state","protocol":3,"sequence":1,"phase":"live","mic":{"muted":false,"effectiveMuted":false,"level":0},"speaker":{"muted":false,"effectiveMuted":false,"level":0}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":4,"sequence":1,"phase":"live","mic":{"muted":false,"effectiveMuted":false,"level":2},"speaker":{"muted":false,"effectiveMuted":false,"level":0}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":4,"sequence":1,"phase":"live","mic":{"muted":false,"level":0},"speaker":{"muted":false,"effectiveMuted":false,"level":0}}',
      ),
    ).toBeNull();
  });
});
