import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxRenderable, type Renderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { KEY_HOLD_LEASE_MS } from "../src/console/audio-control.ts";
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
  test("ignored legacy prompts warn visibly without debug or changing the voice phase", async () => {
    const h = hostHarness();
    writeFileSync(join(h.directory, "VOICE.md"), "LEGACY BODY MUST NOT APPEAR");
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await setup.waitFor(
        () =>
          setup.captureCharFrame().includes("LIVE") &&
          setup.captureCharFrame().includes("Ignoring legacy"),
      );
      const frame = setup.captureCharFrame();
      expect(frame).toContain("VOICE.md");
      expect(frame).toContain("rename it");
      expect(frame).not.toContain("LEGACY BODY MUST NOT APPEAR");
      expect(h.native.alive).toBe(true);
      expect(
        h.native.calls.find((call) => call.method === "thread/start")?.params,
      ).not.toHaveProperty("developerInstructions");
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });
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
      expect(setup.captureCharFrame()).toContain("fresh conversation");
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
    const setup = await createTestRenderer({
      width: 49,
      height: 28,
      exitOnCtrlC: false,
      kittyKeyboard: true,
    });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
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

      // Kitty Space: even a quick tap only opens until release.
      const space = (event: number) =>
        setup.renderer.stdin.emit("data", Buffer.from(`\x1b[32;1:${event}u`));
      space(1);
      expect(h.audio.micMuted).toBe(false);
      space(3);
      expect(h.audio.micMuted).toBe(true);
      space(1);
      space(3);
      expect(h.audio.micMuted).toBe(true);
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
    const h = hostHarness({}, { continue: true });
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
      expect(h.calls).not.toContain("audio:start");
      expect(h.calls).toContain("audio:stop");
      expect(h.calls).toContain("transport:stop");
    } finally {
      await h.cleanup();
    }
  });

  test("quitting while audio opens stops late-opened audio and the prepared child", async () => {
    const h = hostHarness();
    const opening = deferred();
    const entered = deferred();
    h.audio.start = () => {
      entered.resolve();
      return opening.promise;
    };
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await entered.promise;
      expect(h.calls).not.toContain("ready");
      setup.mockInput.pressKey("q");
      opening.resolve();
      await run;
      expect(h.calls.filter((c) => c === "audio:stop").length).toBeGreaterThanOrEqual(2);
      expect(h.native.calls.some((c) => c.method === "thread/start")).toBe(true);
      expect(h.native.closes).toBe(1);
      expect(h.calls).not.toContain("ready");
    } finally {
      opening.resolve();
      await run;
      await h.cleanup();
    }
  });
});

describe("baseline readiness and feedback", () => {
  test("media warnings persist without debug through phase updates and resizing", async () => {
    const h = hostHarness();
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
      h.warnAudio("agent audio decode failed: invalid Opus packet");
      await setup.waitFor(() => setup.captureCharFrame().includes("decode failed"));
      expect(setup.captureCharFrame()).toContain("LIVE");
      h.failTransport("answer rejected: invalid SDP");
      for (const width of [40, 80, 120]) {
        setup.resize(width, 24);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("answer rejected");
        expect(setup.captureCharFrame()).toContain("invalid SDP");
        expect(setup.captureCharFrame()).toContain("FAILED");
      }
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });

  test("shows conversation selection, reported model and Fresh identity", async () => {
    const h = hostHarness({}, { continue: true });
    h.native.main("saved-conversation", h.directory);
    h.native.tiers = true;
    const setup = await createTestRenderer({ width: 120, height: 24, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("Continued: saved-conversation"));
      expect(setup.captureCharFrame()).toContain(h.directory);
      expect(setup.captureCharFrame()).toContain("Model: native-model");
      expect(h.calls.indexOf("audio:start")).toBeLessThan(h.calls.indexOf("ready"));
      setup.mockInput.pressKey("f");
      await setup.waitFor(() => setup.captureCharFrame().includes("Started: thread-1"));
      expect(setup.captureCharFrame()).not.toContain("saved-conversation");
      setup.resize(40, 24);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Started: thread-1");
      expect(setup.captureCharFrame()).toContain(h.directory.slice(-6));
    } finally {
      setup.mockInput.pressKey("q");
      await run;
      await h.cleanup();
    }
  });

  test("invalid prompt, protocol, permissions and Fast readiness never open audio", async () => {
    for (const failure of ["prompt", "protocol", "permissions", "fast"] as const) {
      const h = hostHarness(failure === "protocol" ? { voice: { version: "v2" } } : {});
      if (failure === "prompt") mkdirSync(join(h.directory, "VOICE_AGENT_SYSTEM_PROMPT.md"));
      if (failure === "permissions")
        h.native.override = (method) =>
          method === "thread/start"
            ? Promise.resolve({
                thread: { id: "denied" },
                sandbox: { type: "readOnly" },
                approvalPolicy: "never",
              })
            : undefined;
      if (failure === "fast") h.native.models = [];
      const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
      try {
        await expect(
          runConsoleHost(h.config, "test", {
            mediaFactory: h.mediaFactory,
            runtime: { ...h.runtimeOptions, ...(failure === "fast" ? { fast: true } : {}) },
            tui: { createRenderer: async () => setup.renderer },
          }),
        ).rejects.toThrow();
        expect(h.calls).not.toContain("audio:start");
        expect(h.calls).not.toContain("ready");
        expect(h.native.closes).toBe(failure === "permissions" || failure === "fast" ? 1 : 0);
      } finally {
        await h.cleanup();
      }
    }
  });

  test("quit during native readiness closes the child without opening audio", async () => {
    const h = hostHarness({}, { continue: true });
    const pending = deferred<unknown>();
    const entered = deferred();
    h.native.override = (method) => {
      if (method !== "thread/list") return undefined;
      entered.resolve();
      return pending.promise;
    };
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    try {
      await entered.promise;
      setup.mockInput.pressKey("q");
      pending.resolve({ data: [], nextCursor: null });
      await run;
      expect(h.native.closes).toBe(1);
      expect(h.calls).not.toContain("audio:start");
      expect(h.calls).not.toContain("ready");
    } finally {
      pending.resolve({ data: [], nextCursor: null });
      await run;
      await h.cleanup();
    }
  });

  test("audio-open failure closes the prepared child without negotiating", async () => {
    const h = hostHarness();
    h.audio.start = async () => {
      throw new Error("device unavailable");
    };
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    try {
      await expect(
        runConsoleHost(h.config, "test", {
          mediaFactory: h.mediaFactory,
          runtime: h.runtimeOptions,
          tui: { createRenderer: async () => setup.renderer },
        }),
      ).rejects.toThrow("device unavailable");
      expect(h.native.closes).toBe(1);
      expect(h.calls).not.toContain("ready");
    } finally {
      await h.cleanup();
    }
  });

  test("toggles ignore repeats; PTT holds compose, expire safely and respect palette focus", async () => {
    const h = hostHarness();
    const setup = await createTestRenderer({
      width: 80,
      height: 24,
      exitOnCtrlC: false,
      kittyKeyboard: true,
    });
    const run = runConsoleHost(h.config, "test", {
      mediaFactory: h.mediaFactory,
      runtime: h.runtimeOptions,
      tui: { createRenderer: async () => setup.renderer },
    });
    const key = (code: number, event: number) =>
      setup.renderer.stdin.emit("data", Buffer.from(`\x1b[${code};1:${event}u`));
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("LIVE"));
      for (const [code, muted] of [
        [109, () => h.audio.micMuted],
        [115, () => h.audio.speakerMuted],
      ] as const) {
        key(code, 1);
        expect(muted()).toBe(true);
        key(code, 2);
        key(code, 3);
        expect(muted()).toBe(true);
      }
      key(32, 1);
      expect(h.audio.micMuted).toBe(false);
      key(32, 3);
      expect(h.audio.micMuted).toBe(true);
      await setup.renderOnce();
      const rails = setup.renderer.root.findDescendantById("voice-rails")!;
      const x = rails.x + 2,
        y = rails.y + rails.height - 2;
      await setup.mockMouse.pressDown(x, y);
      key(32, 1);
      await setup.mockMouse.release(x, y);
      expect(h.audio.micMuted).toBe(false);
      key(32, 3);
      expect(h.audio.micMuted).toBe(true);
      key(32, 1);
      await Bun.sleep(KEY_HOLD_LEASE_MS + 30);
      expect(h.audio.micMuted).toBe(true);
      key(32, 2); // late repeats cannot resurrect an expired hold
      expect(h.audio.micMuted).toBe(true);
      key(32, 3);
      key(32, 1);
      setup.mockInput.pressKey("k", { ctrl: true });
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[107;5:2u"));
      expect(h.audio.micMuted).toBe(true);
      key(32, 3);
      key(32, 1);
      key(109, 1);
      expect(h.audio.micMuted).toBe(true);
      setup.mockInput.pressKey("c", { ctrl: true });
      await run;
      expect(h.native.closes).toBe(1);
    } finally {
      setup.mockInput.pressKey("c", { ctrl: true });
      await run;
      await h.cleanup();
    }
  });
});
