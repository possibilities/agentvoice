import { describe, expect, test } from "bun:test";
import { BoxRenderable, type Renderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { AUDIO_CONTROL_CLICK_MS } from "../src/console/audio-control.ts";
import { runConsoleHost } from "../src/console/host.ts";
import { hostHarness } from "./fixtures/host-harness.ts";
import { deferred } from "./fixtures/runtime-harness.ts";

function selectableTextIds(root: Renderable): string[] {
  const ids: string[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof TextRenderable && node.selectable) ids.push(node.id);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return ids.sort();
}

describe("foreground console host", () => {
  test("unsupported interaction remains visible without debug or an approval dialog", async () => {
    const h = hostHarness();
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    const message =
      "Refused tool/requestUserInput: AgentVoice has no approval/input UI. Full access does not grant connector consent or answer tool questions. Use a supported Codex client for required interaction.";
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
      h.native.options.onRefusal!(message);
      await setup.waitFor(() => setup.captureCharFrame().includes("Refused tool/requestUserInput"));
      for (const width of [40, 80, 120]) {
        setup.resize(width, 24);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("connector");
        expect(frame).toContain("interaction.");
        expect(frame).not.toContain("Accept");
        expect(h.native.alive).toBe(true);
      }
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });
  test("shows Fast/Standard reported by Codex and labels unconfirmed requests", async () => {
    for (const [fast, reported, label] of [
      [true, "priority", "Work: Fast"],
      [false, "default", "Work: Standard"],
      [false, undefined, "Work: Standard requested"],
    ] as const) {
      const h = hostHarness();
      h.native.tiers = reported !== undefined;
      const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
      const run = runConsoleHost(h.config, "test", {
        mediaFactory: h.mediaFactory,
        runtime: { ...h.runtimeOptions, fast },
        tui: { createRenderer: async () => setup.renderer },
      });
      try {
        await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
        expect(setup.captureCharFrame()).toContain(label);
        if (reported !== undefined) expect(setup.captureCharFrame()).not.toContain("requested");
        setup.resize(40, 19);
        await setup.waitFor(() => setup.captureCharFrame().includes(label));
      } finally {
        setup.mockInput.pressKey("q");
        await run;
        await h.cleanup();
      }
    }
  });

  test("fills portrait, landscape and shallow viewports; palette and mouse quit still work", async () => {
    const h = hostHarness();
    const setup = await createTestRenderer({ width: 49, height: 46, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
      expect(setup.captureCharFrame()).toContain("/ 48 KHZ");
      expect(setup.captureCharFrame()).toContain("-42.4 dB");
      expect(selectableTextIds(setup.renderer.root)).toEqual([]);
      for (const [width, height] of [
        [49, 46],
        [120, 19],
        [80, 19],
        [40, 19],
        [103, 7],
        [49, 46],
      ] as const) {
        setup.resize(width, height);
        await setup.waitFor(() => {
          const main = setup.renderer.root.findDescendantById("voice-main");
          return (
            main instanceof BoxRenderable &&
            main.y === 0 &&
            main.width === width &&
            main.height === height
          );
        });
        const canvas = setup.renderer.root.findDescendantById(
          "voice-field-canvas",
        ) as TextRenderable;
        expect(canvas.width).toBeLessThanOrEqual(width);
        const rows = canvas.content.chunks
          .map((c) => c.text)
          .join("")
          .split("\n");
        expect(rows.length).toBeLessThanOrEqual(height);
        expect(rows.every((r) => r.length <= width)).toBe(true);
      }
      const trigger = setup.renderer.root.findDescendantById("voice-command-trigger")!;
      await setup.mockMouse.pressDown(trigger.x + Math.floor(trigger.width / 2), trigger.y);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("redial the voice link");
      expect(setup.captureCharFrame()).toContain("fresh orchestrator thread");
      const quit = setup.renderer.root.findDescendantById("voice-palette-command-quit")!;
      await setup.mockMouse.click(quit.x + 2, quit.y);
      await run;
      expect(h.calls).toContain("transport:stop");
      expect(h.calls).toContain("audio:stop");
      expect(h.native.closes).toBe(1);
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });

  test("direct mute, push-to-talk, redial and Fresh controls reach local media/runtime", async () => {
    const h = hostHarness();
    let clock = 1_000;
    const setup = await createTestRenderer({
      width: 49,
      height: 28,
      exitOnCtrlC: false,
      kittyKeyboard: true,
    });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer, now: () => clock },
    });
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
      setup.mockInput.pressKey("r");
      expect(h.calls).toContain("redial");
      setup.mockInput.pressKey("f");
      await setup.waitFor(
        () => h.native.calls.filter((c) => c.method === "thread/start").length === 2,
      );
      expect(h.calls).toContain("signal:lost");
      expect(h.calls).toContain("audio:detach");
      const rails = setup.renderer.root.findDescendantById("voice-rails")!;
      const left = rails.x + 2;
      const right = rails.x + rails.width - 2;
      const y = rails.y + Math.floor(rails.height / 2);
      await setup.mockMouse.pressDown(left, y);
      await setup.mockMouse.release(left, y);
      expect(h.audio.micMuted).toBe(true);
      await setup.mockMouse.pressDown(right, y);
      await setup.mockMouse.release(right, y);
      expect(h.audio.speakerMuted).toBe(true);

      // Pointer push-to-talk never commits, even for a quick tap.
      const pttY = rails.y + rails.height - 2;
      await setup.mockMouse.pressDown(left, pttY);
      expect(h.audio.micMuted).toBe(false);
      await setup.mockMouse.release(left, pttY);
      expect(h.audio.micMuted).toBe(true);
      expect(setup.renderer.hasSelection).toBe(false);

      // Kitty Space: hold opens only until release; quick tap commits.
      const space = (event: number) =>
        setup.renderer.stdin.emit("data", Buffer.from(`\x1b[32;1:${event}u`));
      space(1);
      expect(h.audio.micMuted).toBe(false);
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      space(3);
      expect(h.audio.micMuted).toBe(true);
      space(1);
      clock += AUDIO_CONTROL_CLICK_MS;
      space(3);
      expect(h.audio.micMuted).toBe(false);
      space(1);
      space(3);
      expect(h.audio.micMuted).toBe(true);
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });

  test("startup failure restores terminal and closes child/media", async () => {
    const h = hostHarness();
    h.native.override = (m) =>
      m === "thread/list" ? Promise.reject(new Error("lookup failed")) : undefined;
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    try {
      await expect(
        runConsoleHost(h.config, "test", {
          mediaFactory: h.mediaFactory,
          runtime: h.runtimeOptions,
          tui: { createRenderer: async () => setup.renderer },
        }),
      ).rejects.toThrow("lookup failed");
      expect(h.native.closes).toBe(1);
      expect(h.calls).toContain("audio:stop");
      expect(h.calls).toContain("transport:stop");
    } finally {
      await h.cleanup();
    }
  });

  test("quitting while audio opens stops late-opened audio without starting Codex", async () => {
    const h = hostHarness();
    const opening = deferred();
    h.audio.start = () => opening.promise;
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await setup.waitFor(() => !!setup.renderer.root.findDescendantById("voice-rails"));
      setup.mockInput.pressKey("q");
      opening.resolve();
      await run;
      expect(h.calls.filter((c) => c === "audio:stop").length).toBeGreaterThanOrEqual(2);
      expect(h.native.calls).toHaveLength(0);
    } finally {
      opening.resolve();
      await run;
      await h.cleanup();
    }
  });
});
