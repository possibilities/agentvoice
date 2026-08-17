import { describe, expect, test } from "bun:test";
import {
  AUDIO_CONTROL_CLICK_MS,
  audioControlKeyAction,
  MuteGate,
  pushToTalkKeyAction,
  releaseCommitsClick,
} from "../src/console/audio-control.ts";

describe("audio-control keyboard input", () => {
  test("uses release-capable M and S for holds while raw keys remain toggles", () => {
    expect(audioControlKeyAction({ name: "m", source: "raw", eventType: "press" }, false)).toEqual({
      target: "mic",
      action: "toggle",
    });
    expect(
      audioControlKeyAction({ name: "s", source: "kitty", eventType: "press" }, false),
    ).toEqual({ target: "speaker", action: "begin" });
    expect(
      audioControlKeyAction({ name: "s", source: "kitty", eventType: "repeat" }, false),
    ).toEqual({ target: "speaker", action: "renew" });
    expect(
      audioControlKeyAction({ name: "s", source: "kitty", eventType: "release" }, true),
    ).toEqual({ target: "speaker", action: "end" });
    expect(
      audioControlKeyAction({ name: "m", source: "kitty", eventType: "press" }, true),
    ).toBeNull();
  });

  test("keeps Space dedicated to push-to-talk", () => {
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

  test("classifies the click boundary without delaying the held state", () => {
    expect(releaseCommitsClick(10, 10 + AUDIO_CONTROL_CLICK_MS)).toBe(true);
    expect(releaseCommitsClick(10, 11 + AUDIO_CONTROL_CLICK_MS)).toBe(false);
  });
});

describe("MuteGate", () => {
  test("preserves the hands-free default", () => {
    expect(new MuteGate().state()).toEqual({
      muted: false,
      holding: false,
      effectiveMuted: false,
    });
  });

  test("holds either value without changing the persistent assignment", () => {
    const mic = new MuteGate(true);
    const speaker = new MuteGate(false);

    expect(mic.hold("pointer", false)).toBe(true);
    expect(mic.state()).toEqual({ muted: true, holding: true, effectiveMuted: false });
    expect(speaker.hold("pointer", true)).toBe(true);
    expect(speaker.state()).toEqual({ muted: false, holding: true, effectiveMuted: true });

    mic.release("pointer");
    speaker.release("pointer");
    expect(mic.effectiveMuted).toBe(true);
    expect(speaker.effectiveMuted).toBe(false);
  });

  test("lets the newest source win and reveals older holds on release", () => {
    const gate = new MuteGate(false);

    gate.hold("first", true);
    gate.hold("second", false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.release("second")).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
    expect(gate.release("first")).toBe(true);
    expect(gate.effectiveMuted).toBe(false);
  });

  test("commits a click atomically while a hold release restores the assignment", () => {
    const gate = new MuteGate(true);

    gate.hold("click", false);
    expect(gate.release("click", true)).toBe(true);
    expect(gate.state()).toEqual({ muted: false, holding: false, effectiveMuted: false });

    gate.hold("hold", true);
    expect(gate.release("hold", false)).toBe(true);
    expect(gate.state()).toEqual({ muted: false, holding: false, effectiveMuted: false });
  });

  test("keeps a persistent change underneath an active hold", () => {
    const gate = new MuteGate(true);
    gate.hold("remote", false);

    expect(gate.setMuted(false)).toBe(true);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.setMuted(true)).toBe(true);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.release("remote")).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
  });
});
