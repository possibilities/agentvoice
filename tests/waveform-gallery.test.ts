import { expect, test } from "bun:test";
import { MouseEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { WaveformGallery } from "../scripts/waveforms/app.ts";
import { Raster } from "../scripts/waveforms/raster.ts";
import { defaults, renderStudy, studies } from "../scripts/waveforms/studies.ts";
import { backgroundMode, FxTheme, palette } from "../scripts/waveforms/theme.ts";

test("all studies are distinct, animate, and stay bounded at parameter extremes", () => {
  const fingerprints = new Set<string>();
  for (let i = 0; i < studies.length; i++) {
    const first = renderStudy(i, 36, 10, 0.4, defaults());
    const later = renderStudy(i, 36, 10, 1.7, defaults());
    fingerprints.add(Buffer.from(first.pixels).toString("base64"));
    expect(first.pixels.some((value) => value > 0)).toBe(true);
    expect(first.pixels).not.toEqual(later.pixels);
    for (const [width, height] of [
      [1, 1],
      [7, 3],
      [80, 24],
    ]) {
      for (const p of [
        { speed: 3, amplitude: 1.75, frequency: 3 },
        { speed: 0.25, amplitude: 0.25, frequency: 0.25 },
      ]) {
        const raster = renderStudy(i, width!, height!, 4000.5, p);
        expect(raster.pixels.every((value) => value >= 0 && value <= 5)).toBe(true);
        expect(raster.pixels.length).toBeLessThanOrEqual(width! * height! * 8);
      }
    }
  }
  expect(fingerprints.size).toBe(12);
  expect(() => renderStudy(0, 10000, 10000, 0, defaults())).toThrow("dimensions");
  expect(() => renderStudy(0, 40, 20, Number.NaN, defaults())).toThrow("finite");
});

test("a lower-only half block keeps the upper half on the terminal background", () => {
  const raster = new Raster(1, 1, "blocks");
  raster.point(0, 1, 3);
  expect(raster.cell(0, 0)).toEqual({ char: "▄", ink: 3, lower: 0 });
  raster.point(0, 0, 5);
  expect(raster.cell(0, 0)).toEqual({ char: "▀", ink: 5, lower: 3 });
});

async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click(lines[y]!.indexOf(text), y);
  await setup.renderOnce();
}

test("gallery navigation reaches every study after reflow, and controls stay in view", async () => {
  const setup = await createTestRenderer({ width: 120, height: 42, kittyKeyboard: true });
  const gallery = new WaveformGallery(setup.renderer, { animate: false });
  try {
    for (const [width, height] of [
      [120, 42],
      [80, 24],
      [40, 24],
      [80, 12],
      [32, 12],
    ]) {
      setup.resize(width!, height!);
      for (let i = 0; i < studies.length; i++) {
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain(studies[gallery.state.selected]!.name);
        expect(frame).toContain("[Quit]");
        expect(
          [...frame].some(
            (char) => (char >= "\u2801" && char <= "\u28ff") || char === "▀" || char === "▄",
          ),
        ).toBe(true);
        expect(frame.split("\n").every((row) => [...row].length <= width!)).toBe(true);
        setup.mockInput.pressArrow("right");
      }
      setup.mockInput.pressEnter();
      await setup.renderOnce();
      const detail = setup.captureCharFrame();
      if (height! >= 24 || width! >= 80) expect(detail).toContain("amplitude");
      expect([...detail].some((char) => char >= "\u2801" && char <= "\u28ff")).toBe(true);
      expect(detail).toContain("[Gallery]");
      setup.mockInput.pressEscape();
      await setup.renderOnce();
      expect(gallery.state.expanded).toBe(false);
    }
    setup.resize(15, 4);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("[Quit]");
  } finally {
    gallery.close();
  }
});

test("keyboard and pointer controls share state, and the palette owns its inputs", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const gallery = new WaveformGallery(setup.renderer, { animate: false });
  try {
    await setup.renderOnce();
    await clickText(setup, "Phosphor scope");
    expect(gallery.state.expanded).toBe(true);
    setup.mockInput.pressKey("]");
    setup.mockInput.pressKey("+");
    setup.mockInput.pressKey(".");
    expect(gallery.state.parameters).toEqual({ speed: 1.25, amplitude: 1.125, frequency: 1.25 });
    await setup.renderOnce();
    await clickText(setup, "[+]");
    expect(gallery.state.parameters.speed).toBe(1.5);
    const rows = setup.captureCharFrame().split("\n");
    const amplitudeRow = rows.findIndex((row) => row.includes("amplitude"));
    await setup.mockMouse.scroll(rows[amplitudeRow]!.indexOf("amplitude"), amplitudeRow, "down");
    expect(gallery.state.parameters.amplitude).toBe(1);
    for (let i = 0; i < 30; i++) setup.mockInput.pressKey("]");
    expect(gallery.state.parameters.speed).toBe(3);
    setup.mockInput.pressKey("0");
    expect(gallery.state.parameters).toEqual(defaults());
    setup.mockInput.pressKey(" ");
    expect(gallery.state.paused).toBe(true);
    await setup.renderOnce();
    const frozen = setup.captureCharFrame();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toBe(frozen);
    await clickText(setup, "[Commands]");
    await setup.mockInput.typeText("frequency");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Increase frequency");
    expect(gallery.state.parameters.frequency).toBe(1);
    await clickText(setup, "Increase frequency");
    expect(gallery.state.commandsOpen).toBe(false);
    expect(gallery.state.parameters.frequency).toBe(1.25);
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.renderOnce();
    await setup.mockMouse.click(15, 4); // Empty interior does not activate the plot underneath.
    expect(gallery.state.commandsOpen).toBe(true);
    await setup.mockMouse.click(0, 0);
    expect(gallery.state.commandsOpen).toBe(false);
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.mockInput.typeText("rose");
    setup.mockInput.pressEnter();
    expect(studies[gallery.state.selected]!.name).toBe("Phase rose");
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.mockInput.typeText("zzzzzz");
    for (const [width, height] of [
      [40, 24],
      [32, 12],
      [120, 42],
    ]) {
      setup.resize(width!, height!);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("No matching commands");
      expect(setup.captureCharFrame()).toContain("[Close]");
      setup.mockInput.pressEnter();
      expect(gallery.state.commandsOpen).toBe(true);
    }
  } finally {
    gallery.close();
  }
});

test("gallery rejects stale pointer targets between a keyboard transition and its next frame", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const gallery = new WaveformGallery(setup.renderer, { animate: false });
  const click = () =>
    gallery.processMouseEvent(
      new MouseEvent(gallery, {
        type: "down",
        button: 0,
        x: 15,
        y: 5,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    );
  try {
    await setup.renderOnce();
    setup.mockInput.pressKey("k", { ctrl: true });
    click();
    expect(gallery.state.commandsOpen).toBe(true);
    expect(gallery.state.expanded).toBe(false);
    await setup.renderOnce();
    setup.mockInput.pressKey("z");
    click();
    expect(gallery.state.commandsOpen).toBe(true);
    expect(gallery.state.paused).toBe(false);
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    click();
    expect(gallery.state.commandsOpen).toBe(false);
    expect(gallery.state.expanded).toBe(false);
  } finally {
    gallery.close();
  }
});

test("animation releases its live lease on pause, blur, modal input, and renderer destruction", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const before = setup.renderer.keyInput.listenerCount("keypress");
  const gallery = new WaveformGallery(setup.renderer);
  try {
    expect(gallery.live).toBe(true);
    setup.mockInput.pressKey(" ");
    expect(gallery.live).toBe(false);
    setup.mockInput.pressKey(" ");
    setup.renderer.emit("blur");
    expect(gallery.live).toBe(false);
    setup.renderer.emit("focus");
    expect(gallery.live).toBe(true);
    setup.mockInput.pressKey("k", { ctrl: true });
    expect(gallery.live).toBe(false);
    setup.mockInput.pressCtrlC();
    await gallery.done;
    expect(gallery.live).toBe(false);
    expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(before);
    expect(setup.renderer.liveRequestCount).toBe(0);
    expect(setup.renderer.isDestroyed).toBe(true);
  } finally {
    gallery.close();
  }
});

test("fxnk uses fixed indexed ramps and preserves the terminal default background", () => {
  expect(
    palette("dark")
      .ink.map((color) => color.slot)
      .slice(1),
  ).toEqual([240, 245, 250, 252, 255]);
  expect(
    palette("light")
      .ink.map((color) => color.slot)
      .slice(1),
  ).toEqual([250, 247, 241, 238, 235]);
  expect(palette("dark").background.intent).toBe("default");
  expect(palette("light").focus.slot).toBe(4);
  expect(backgroundMode("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe("light");
  expect(backgroundMode("\x1b]11;rgb:12/12/12\x07")).toBe("dark");
  expect(backgroundMode("\x1b]11;rgb:ffff/ffff/ffff")).toBeUndefined();
});

test("explicit fxnk mode owns replies without querying or retinting", async () => {
  const theme = new FxTheme({ FX_THEME: "LiGhT", COLORFGBG: "15;0" });
  const writes: string[] = [];
  try {
    await theme.start((sequence) => {
      writes.push(sequence);
    });
    theme.handle("\x1b[?997;1n");
    theme.handle("\x1b]11;rgb:00/00/00\x07");
    expect(theme.mode).toBe("light");
    expect(writes).toEqual(["\x1b[?2031h"]);
  } finally {
    theme.dispose();
  }
  expect(writes.at(-1)).toBe("\x1b[?2031l");
});

test("live theme refresh fences stale replies and newer notifications invalidate pending samples", async () => {
  const theme = new FxTheme({ COLORFGBG: "0;15" });
  const writes: string[] = [];
  const modes: string[] = [];
  theme.onChange = (mode) => {
    modes.push(mode);
  };
  try {
    const initialized = theme.start((sequence) => {
      writes.push(sequence);
    });
    theme.handle("\x1b]11;rgb:00/00/00\x07");
    await initialized;
    expect(theme.mode).toBe("dark");
    theme.handle("\x1b[?997;2n");
    theme.handle("\x1b]11;rgb:ff/ff/ff\x07");
    expect(theme.mode).toBe("dark");
    theme.handle("\x1b[?1;2c");
    expect(writes.at(-1)).toBe("\x1b]11;?\x1b\\");
    theme.handle("\x1b[?997;1n");
    theme.handle("\x1b]11;rgb:ff/ff/ff\x07");
    expect(theme.mode).toBe("dark");
    theme.handle("\x1b[?1;2c");
    theme.handle("\x1b]11;rgb:ff/ff/ff\x07");
    expect(theme.mode).toBe("light");
    expect(modes).toEqual(["dark", "light"]);
  } finally {
    theme.dispose();
  }
});

test("startup timeout uses COLORFGBG and ignores a late initial background reply", async () => {
  const theme = new FxTheme({ COLORFGBG: "0;15" });
  try {
    await theme.start(() => {});
    expect(theme.mode).toBe("light");
    theme.handle("\x1b]11;rgb:00/00/00\x07");
    expect(theme.mode).toBe("light");
  } finally {
    theme.dispose();
  }
});

test("fxnk theme disposal resolves startup and never re-enables modes after destruction", async () => {
  const writes: string[] = [];
  const theme = new FxTheme({});
  const startup = theme.start((sequence) => {
    writes.push(sequence);
  });
  theme.dispose();
  await startup;
  expect(writes.at(-1)).toBe("\x1b[?2031l");
  const count = writes.length;
  await theme.start((sequence) => {
    writes.push(sequence);
  });
  expect(writes.length).toBe(count);
});
