import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandPalette, type PaletteCommand, paletteMatches } from "../src/tui/palette.ts";

const TOKENS = {
  panel: "#131a1e",
  line: "#333333",
  accent: "#00ffff",
  muted: "#999999",
  text: "#eeeeee",
};

const commands = (ran: string[] = []): PaletteCommand[] => [
  { id: "mic", key: "M", label: "mic — mute", onRun: () => ran.push("mic") },
  { id: "speaker", key: "S", label: "speaker — mute", onRun: () => ran.push("speaker") },
  { id: "redial", key: "R", label: "redial the voice link", onRun: () => ran.push("redial") },
  { id: "quit", key: "Q", label: "quit", onRun: () => ran.push("quit") },
];

describe("palette filtering", () => {
  test("matches label and key case-insensitively, empty filter keeps all", () => {
    const all = commands();
    expect(paletteMatches(all, "")).toHaveLength(4);
    expect(paletteMatches(all, "mute").map((command) => command.id)).toEqual(["mic", "speaker"]);
    expect(paletteMatches(all, "r").map((command) => command.id)).toEqual(["speaker", "redial"]);
    expect(paletteMatches(all, "nope")).toHaveLength(0);
  });
});

describe("command palette", () => {
  test("does not close again when ctrl+k repeats", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const palette = createCommandPalette(core, setup.renderer, "repeat-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(), width: 80, height: 24 });

    expect(palette.handleKey({ name: "k", ctrl: true, eventType: "press" })).toBe(true);
    expect(palette.isOpen()).toBe(true);
    expect(palette.handleKey({ name: "k", ctrl: true, eventType: "repeat" })).toBe(true);
    expect(palette.isOpen()).toBe(true);

    setup.renderer.destroy();
  });

  test("opens on real ctrl+k input, filters typed text, and runs on enter", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const keys = setup.mockInput;
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "voice-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });
    const seen: string[] = [];
    setup.renderer.keyInput.on("keypress", (key: core.ParsedKey) => {
      if (palette.handleKey(key)) return;
      seen.push(key.name);
    });

    keys.pressKey("q");
    expect(seen).toEqual(["q"]);
    expect(palette.isOpen()).toBe(false);

    keys.pressKey("k", { ctrl: true });
    expect(palette.isOpen()).toBe(true);
    await setup.flush();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("COMMANDS");
    expect(frame).toContain("[M]");
    expect(frame).toContain("redial the voice link");

    await keys.typeText("redial");
    await setup.flush();
    frame = setup.captureCharFrame();
    expect(frame).toContain("redial the voice link");
    expect(frame).not.toContain("speaker — mute");

    keys.pressEnter();
    expect(ran).toEqual(["redial"]);
    expect(palette.isOpen()).toBe(false);
    expect(palette.root.visible).toBe(false);
    expect(seen).toEqual(["q"]);
    setup.renderer.destroy();
  });

  test("escape closes without running and app keys resume", async () => {
    // Kitty keyboard: a lone legacy ESC byte coalesces with whatever follows
    // it in the mock stream, so only the kitty encoding delivers "escape".
    const setup = await createTestRenderer({
      width: 80,
      height: 24,
      exitOnCtrlC: false,
      kittyKeyboard: true,
    });
    const keys = setup.mockInput;
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "esc-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });
    const seen: string[] = [];
    setup.renderer.keyInput.on("keypress", (key: core.ParsedKey) => {
      if (palette.handleKey(key)) return;
      seen.push(key.name);
    });

    keys.pressKey("k", { ctrl: true });
    keys.pressKey("ARROW_DOWN");
    keys.pressKey("ESCAPE");
    expect(palette.isOpen()).toBe(false);
    expect(ran).toHaveLength(0);
    keys.pressKey("m");
    expect(seen).toEqual(["m"]);
    setup.renderer.destroy();
  });

  test("runs a command from a pointer tap and keeps ctrl+c for the terminal", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
    const keys = setup.mockInput;
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, "tap-palette", TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });
    const seen: string[] = [];
    setup.renderer.keyInput.on("keypress", (key: core.ParsedKey) => {
      if (palette.handleKey(key)) return;
      seen.push(`${key.ctrl ? "ctrl+" : ""}${key.name}`);
    });

    keys.pressKey("k", { ctrl: true });
    keys.pressKey("c", { ctrl: true });
    expect(seen).toEqual(["ctrl+c"]);

    await setup.flush();
    const row = setup.renderer.root.findDescendantById("tap-palette-command-speaker");
    expect(row).toBeInstanceOf(core.BoxRenderable);
    await setup.mockMouse.click(row!.x + 2, row!.y);
    expect(ran).toEqual(["speaker"]);
    expect(palette.isOpen()).toBe(false);
    setup.renderer.destroy();
  });
});
