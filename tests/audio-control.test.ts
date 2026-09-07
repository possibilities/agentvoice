import { describe, expect, test } from "bun:test";
import { MuteGate } from "../src/console/audio-control.ts";

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
