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
      mic: { muted: false, level: 0.75 },
      speaker: { muted: true, level: 0.25 },
    } as const;
    expect(parseRemoteState(encodeRemoteMessage(state).trim())).toEqual(state);
  });

  test("accepts idempotent mute assignments and refuses malformed commands", () => {
    expect(parseRemoteCommand('{"type":"set-muted","target":"mic","muted":true}')).toEqual({
      type: "set-muted",
      target: "mic",
      muted: true,
    });
    expect(parseRemoteCommand('{"type":"toggle","target":"mic"}')).toBeNull();
    expect(parseRemoteCommand('{"type":"set-muted","target":"server","muted":true}')).toBeNull();
    expect(parseRemoteCommand("nope")).toBeNull();
  });

  test("rejects incompatible and out-of-range state", () => {
    expect(
      parseRemoteState(
        '{"type":"state","protocol":2,"sequence":1,"phase":"live","mic":{"muted":false,"level":0},"speaker":{"muted":false,"level":0}}',
      ),
    ).toBeNull();
    expect(
      parseRemoteState(
        '{"type":"state","protocol":1,"sequence":1,"phase":"live","mic":{"muted":false,"level":2},"speaker":{"muted":false,"level":0}}',
      ),
    ).toBeNull();
  });
});
