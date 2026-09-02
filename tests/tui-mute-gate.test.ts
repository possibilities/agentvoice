import { describe, expect, test } from "bun:test";
import {
  audioControlKeyAction,
  MuteGate,
  releaseCommitsClick,
  spaceControlKeyAction,
} from "../src/tui/mute-gate.ts";

describe("mute gate", () => {
  test("holds open a muted channel until the last source releases", () => {
    const gate = new MuteGate(true);
    expect(gate.effectiveMuted).toBe(true);
    expect(gate.beginUnmute("space")).toBe(true);
    // A second hold changes nothing observable; the channel is already open.
    expect(gate.beginUnmute("key")).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.releaseUnmute("space")).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.releaseUnmute("key")).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
    expect(gate.muted).toBe(true);
  });

  test("a hold cannot open a live channel and a release only affects its own source", () => {
    const gate = new MuteGate(false);
    expect(gate.beginUnmute("space")).toBe(false);
    expect(gate.releaseUnmute("space")).toBe(false);
    gate.setMuted(true);
    gate.beginUnmute("space");
    expect(gate.releaseUnmute("key")).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
  });

  test("a committed release turns the hold into a persistent unmute", () => {
    const gate = new MuteGate(true);
    gate.beginUnmute("key");
    expect(gate.releaseUnmute("key", true)).toBe(true);
    expect(gate.state()).toEqual({ muted: false, holding: false, effectiveMuted: false });
  });
});

describe("key gestures", () => {
  test("kitty press and release bracket a hold; raw presses toggle", () => {
    expect(audioControlKeyAction({ name: "m", source: "kitty", eventType: "press" })).toEqual({
      target: "mic",
      action: "begin",
    });
    expect(audioControlKeyAction({ name: "s", source: "kitty", eventType: "repeat" })).toEqual({
      target: "speaker",
      action: "renew",
    });
    expect(audioControlKeyAction({ name: "m", source: "kitty", eventType: "release" })).toEqual({
      target: "mic",
      action: "end",
    });
    expect(audioControlKeyAction({ name: "m", source: "raw", eventType: "press" })).toEqual({
      target: "mic",
      action: "toggle",
    });
    expect(audioControlKeyAction({ name: "x", source: "kitty", eventType: "press" })).toBeNull();
  });

  test("space is push-to-talk only under the kitty protocol", () => {
    expect(spaceControlKeyAction({ name: "space", source: "kitty", eventType: "press" })).toBe(
      "begin",
    );
    expect(spaceControlKeyAction({ name: "space", source: "kitty", eventType: "release" })).toBe(
      "end",
    );
    expect(spaceControlKeyAction({ name: "space", source: "raw", eventType: "press" })).toBeNull();
  });

  test("a quick release counts as a click", () => {
    expect(releaseCommitsClick(1_000, 1_200)).toBe(true);
    expect(releaseCommitsClick(1_000, 1_400)).toBe(false);
  });
});
