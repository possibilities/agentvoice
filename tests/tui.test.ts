import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { MuteGate } from "../src/console/audio-control.ts";
import type { VoiceState } from "../src/console/state.ts";
import { createVoiceTui } from "../src/console/tui.ts";

test("static monochrome pointer buttons fill resized terminals; keys do nothing", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
  const mic = new MuteGate();
  const speaker = new MuteGate();
  const state = (): VoiceState => ({
    available: true,
    phase: "live",
    notice: "HIDDEN NOTICE",
    workspace: "/hidden",
    mic: { ...mic.state() },
    speaker: { ...speaker.state() },
  });
  let stops = 0;
  const tui = await createVoiceTui(
    {
      state,
      setMuted: (target, value) => (target === "mic" ? mic : speaker).setMuted(value),
      beginUnmute: () => mic.beginUnmute("pointer"),
      releaseUnmute: () => mic.releaseUnmute("pointer"),
      shutdown: () => {
        stops++;
      },
    },
    { createRenderer: async () => setup.renderer },
  );
  try {
    for (const [width, height] of [
      [80, 24],
      [40, 35],
      [120, 12],
      [30, 7],
    ]) {
      setup.resize(width!, height!);
      tui.refresh();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("LIVE");
      expect(frame).toContain("YOU");
      expect(frame).toContain("AGENT");
      expect(frame).not.toContain("PUSH TO TALK");
      expect(frame).not.toMatch(/HIDDEN|hidden|42|18|1234/);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toBe(frame);
    }
    for (const key of ["m", "s", "r", "f", "q", "space"]) setup.mockInput.pressKey(key);
    setup.mockInput.pressKey("k", { ctrl: true });
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.renderOnce();
    expect(mic.muted).toBe(false);
    expect(speaker.muted).toBe(false);
    expect(stops).toBe(0);
    expect(setup.renderer.root.findDescendantById("voice-palette")).toBeUndefined();
    setup.resize(80, 24);
    await setup.renderOnce();
    const microphone = setup.renderer.root.findDescendantById("voice-mic")!;
    await setup.mockMouse.click(microphone.x + 2, microphone.y + 2);
    await setup.renderOnce();
    expect(mic.muted).toBe(true);
    expect(setup.captureCharFrame()).toContain("PUSH TO TALK");
    const ptt = setup.renderer.root.findDescendantById("voice-ptt")!;
    await setup.mockMouse.pressDown(ptt.x + 2, ptt.y + 2);
    expect(mic.effectiveMuted).toBe(false);
    await setup.mockMouse.release(ptt.x + 2, ptt.y + 2);
    expect(mic.effectiveMuted).toBe(true);
    await setup.mockMouse.pressDown(ptt.x + 2, ptt.y + 2);
    tui.cancelInputs();
    expect(mic.effectiveMuted).toBe(true);
    await setup.mockMouse.release(ptt.x + 2, ptt.y + 2);
    const output = setup.renderer.root.findDescendantById("voice-speaker")!;
    await setup.mockMouse.click(output.x + 2, output.y + 2);
    expect(speaker.muted).toBe(true);
  } finally {
    await tui.shutdown();
  }
  expect(stops).toBe(1);
});
