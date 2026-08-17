import { describe, expect, test } from "bun:test";
import { PushToTalkGate, pushToTalkKeyAction } from "../src/console/push-to-talk.ts";

describe("push-to-talk keyboard input", () => {
  test("requires Kitty press/repeat/release events and defers presses to an open palette", () => {
    expect(
      pushToTalkKeyAction({ name: "space", source: "raw", eventType: "press" }, false),
    ).toBeNull();
    expect(pushToTalkKeyAction({ name: "space", source: "kitty", eventType: "press" }, false)).toBe(
      "renew",
    );
    expect(
      pushToTalkKeyAction({ name: "space", source: "kitty", eventType: "repeat" }, false),
    ).toBe("renew");
    expect(
      pushToTalkKeyAction({ name: "space", source: "kitty", eventType: "press" }, true),
    ).toBeNull();
    expect(
      pushToTalkKeyAction({ name: "space", source: "kitty", eventType: "release" }, true),
    ).toBe("end");
  });
});

describe("PushToTalkGate", () => {
  test("preserves the hands-free default", () => {
    const gate = new PushToTalkGate();

    expect(gate.state()).toEqual({ muted: false, talking: false, effectiveMuted: false });
  });

  test("momentarily opens a persistently muted microphone", () => {
    const gate = new PushToTalkGate();
    const keyboard = Symbol("keyboard");

    expect(gate.setMuted(true)).toBe(true);
    expect(gate.state()).toEqual({ muted: true, talking: false, effectiveMuted: true });

    expect(gate.begin(keyboard)).toBe(true);
    expect(gate.state()).toEqual({ muted: true, talking: true, effectiveMuted: false });

    expect(gate.end(keyboard)).toBe(true);
    expect(gate.state()).toEqual({ muted: true, talking: false, effectiveMuted: true });
  });

  test("keeps independent holds open until the last source releases", () => {
    const gate = new PushToTalkGate(true);
    const keyboard = Symbol("keyboard");
    const remote = {};

    expect(gate.begin(keyboard)).toBe(true);
    expect(gate.begin(remote)).toBe(false);
    expect(gate.end(keyboard)).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.end(remote)).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
  });

  test("does not retain a hold begun while the microphone is live", () => {
    const gate = new PushToTalkGate();
    const keyboard = Symbol("keyboard");

    expect(gate.begin(keyboard)).toBe(false);
    expect(gate.setMuted(true)).toBe(true);
    expect(gate.state()).toEqual({ muted: true, talking: false, effectiveMuted: true });
  });

  test("persistent unmute clears active holds", () => {
    const gate = new PushToTalkGate(true);
    const keyboard = Symbol("keyboard");

    gate.begin(keyboard);
    expect(gate.setMuted(false)).toBe(true);
    expect(gate.state()).toEqual({ muted: false, talking: false, effectiveMuted: false });

    expect(gate.setMuted(true)).toBe(true);
    expect(gate.state()).toEqual({ muted: true, talking: false, effectiveMuted: true });
  });
});
