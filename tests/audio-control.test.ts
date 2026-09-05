import { describe, expect, test } from "bun:test";
import { buildKittyKeyboardFlags } from "@opentui/core";
import {
  AUDIO_CONTROL_KITTY_KEYBOARD,
  audioControlKeyAction,
  MuteGate,
  spaceControlKeyAction,
} from "../src/console/audio-control.ts";

describe("audio-control keyboard input", () => {
  test("requests event reports for printable control keys", () => {
    const flags = buildKittyKeyboardFlags(AUDIO_CONTROL_KITTY_KEYBOARD);

    expect(flags & 2).toBe(2);
    expect(flags & 8).toBe(8);
  });

  test("M and S toggle on press only in either terminal protocol, outside the palette", () => {
    for (const source of ["raw", "kitty"] as const) {
      for (const [name, target] of [
        ["m", "mic"],
        ["s", "speaker"],
      ] as const) {
        expect(audioControlKeyAction({ name, source, eventType: "press" }, false)).toEqual({
          target,
          action: "toggle",
        });
        expect(audioControlKeyAction({ name, source, eventType: "press" }, true)).toBeNull();
        for (const eventType of ["repeat", "release"] as const)
          expect(audioControlKeyAction({ name, source, eventType }, false)).toBeNull();
      }
    }
  });

  test("classifies Space as a release-capable microphone control", () => {
    expect(
      spaceControlKeyAction({ name: "space", source: "raw", eventType: "press" }, false),
    ).toBeNull();
    expect(
      spaceControlKeyAction({ name: "space", source: "kitty", eventType: "press" }, false),
    ).toBe("begin");
    expect(
      spaceControlKeyAction({ name: "space", source: "kitty", eventType: "repeat" }, false),
    ).toBe("renew");
    expect(
      spaceControlKeyAction({ name: "space", source: "kitty", eventType: "press" }, true),
    ).toBeNull();
    expect(
      spaceControlKeyAction({ name: "space", source: "kitty", eventType: "release" }, true),
    ).toBe("end");
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

  test("opens only a persistently muted channel and restores it on release", () => {
    const gate = new MuteGate(true);

    expect(gate.beginUnmute("pointer")).toBe(true);
    expect(gate.state()).toEqual({ muted: true, holding: true, effectiveMuted: false });
    expect(gate.releaseUnmute("pointer")).toBe(true);
    expect(gate.state()).toEqual({ muted: true, holding: false, effectiveMuted: true });

    gate.setMuted(false);
    expect(gate.beginUnmute("pointer")).toBe(false);
    expect(gate.state()).toEqual({ muted: false, holding: false, effectiveMuted: false });
  });

  test("keeps independent unmute holds open until the last source releases", () => {
    const gate = new MuteGate(true);

    expect(gate.beginUnmute("first")).toBe(true);
    expect(gate.beginUnmute("second")).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.releaseUnmute("first")).toBe(false);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.releaseUnmute("second")).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
  });

  test("keeps a persistent change underneath an active unmute hold", () => {
    const gate = new MuteGate(true);
    gate.beginUnmute("remote");

    expect(gate.setMuted(false)).toBe(true);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.setMuted(true)).toBe(true);
    expect(gate.effectiveMuted).toBe(false);
    expect(gate.releaseUnmute("remote")).toBe(true);
    expect(gate.effectiveMuted).toBe(true);
  });
});
