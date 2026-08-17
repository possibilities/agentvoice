import { describe, expect, test } from "bun:test";
import {
  mixHex,
  SignalField,
  signalFieldText,
  signalFieldWashColor,
  WASH_STEPS,
} from "../src/console/signal-field.ts";
import { boundedViewportExtent, boundedViewportSize } from "../src/console/signal-field-ui.ts";

const CLASH_GLYPHS = ["╳", "┼", "┿", "╬", "※", "#"];

function countTone(field: ReturnType<SignalField["render"]>, tone: string): number {
  return field.rows.flat().filter((cell) => cell.tone === tone).length;
}

function countWashed(field: ReturnType<SignalField["render"]>): number {
  return field.rows.flat().filter((cell) => cell.wash !== undefined).length;
}

function washText(field: ReturnType<SignalField["render"]>): string {
  return field.rows
    .flat()
    .map((cell) => (cell.wash === undefined ? "." : cell.wash.toString(36)))
    .join("");
}

function maxHorizontalStepDelta(field: ReturnType<SignalField["render"]>): number {
  let max = 0;
  for (const row of field.rows) {
    for (let x = 1; x < row.length; x++) {
      const left = row[x - 1]?.wash ?? 0;
      const right = row[x]?.wash ?? 0;
      max = Math.max(max, Math.abs(right - left));
    }
  }
  return max;
}

function changedCells(left: string, right: string): number {
  return [...left].filter((char, index) => char !== right[index]).length;
}

describe("signal field", () => {
  test("bounds transient layout geometry to the terminal viewport", () => {
    expect(boundedViewportSize(103, 14_680_069, 103, 19)).toEqual({ width: 103, height: 19 });
    expect(boundedViewportSize(Number.POSITIVE_INFINITY, Number.NaN, 49, 46)).toEqual({
      width: 1,
      height: 1,
    });
    expect(boundedViewportExtent(18.9, 10.8)).toBe(10);
    expect(boundedViewportExtent(-5, 19)).toBe(1);
  });

  test("renders exact requested dimensions at narrow and wide widths", () => {
    const field = new SignalField({ seed: 7 });
    for (const [width, height] of [
      [1, 1],
      [18, 3],
      [72, 7],
    ] as const) {
      const frame = field.render(width, height);
      expect(frame.rows).toHaveLength(height);
      expect(frame.rows.every((row) => row.length === width)).toBe(true);
      expect(
        signalFieldText(frame)
          .split("\n")
          .every((row) => row.length === width),
      ).toBe(true);
    }
  });

  test("is deterministic for equal inputs and seeds", () => {
    const left = new SignalField({ seed: 31 });
    const right = new SignalField({ seed: 31 });
    for (let i = 0; i < 20; i++) {
      const input = { you: i % 4 === 0 ? 0.9 : 0.35, agent: i % 7 === 0 ? 0.7 : 0.1 };
      left.step(1 / 30, input);
      right.step(1 / 30, input);
    }
    expect(left.render(48, 6)).toEqual(right.render(48, 6));
  });

  test("standby is paper and undulation — no voice glyphs, smooth in space, continuous in time", () => {
    for (const standby of ["swell", "pond", "weave"] as const) {
      const field = new SignalField({ seed: 41, standby });
      const initialFrame = field.render(72, 9);
      const area = 72 * 9;
      const idleChars = new Set(signalFieldText(initialFrame).replaceAll("\n", ""));
      const paperChars = [" ", "│", "─", "┼", "┃", "━", "╋", "╂", "┿", "▕", "▏", "▁", "▔"];
      expect([...idleChars].every((char) => paperChars.includes(char))).toBe(true);
      expect(countTone(initialFrame, "you")).toBe(0);
      expect(countTone(initialFrame, "agent")).toBe(0);
      expect(countTone(initialFrame, "grid")).toBeGreaterThan(0);
      expect(countWashed(initialFrame)).toBeGreaterThan(area * 0.3);
      expect(maxHorizontalStepDelta(initialFrame)).toBeLessThanOrEqual(2);

      const initial = washText(initialFrame);
      for (let i = 0; i < 6; i++) field.step(1 / 30, { you: 0, agent: 0 });
      const soon = washText(field.render(72, 9));
      expect(changedCells(initial, soon)).toBeGreaterThan(0);
      expect(changedCells(initial, soon)).toBeLessThan(area * 0.4);

      for (let i = 0; i < 150; i++) field.step(1 / 30, { you: 0, agent: 0 });
      const later = washText(field.render(72, 9));
      expect(changedCells(initial, later)).toBeGreaterThan(changedCells(initial, soon));
    }
  });

  test("voice lays over the undulating floor without clearing it", () => {
    const silent = new SignalField({ seed: 11 });
    const speaking = new SignalField({ seed: 11 });
    for (let i = 0; i < 12; i++) {
      silent.step(1 / 30, { you: 0, agent: 0 });
      speaking.step(1 / 30, { you: 1, agent: 0 });
    }
    const idle = silent.render(60, 7);
    const active = speaking.render(60, 7);
    const neutralActive = active.rows
      .flat()
      .filter((cell) => cell.char !== " " && (cell.tone === "faint" || cell.tone === "dim"));
    expect(countWashed(idle)).toBeGreaterThan(0);
    expect(countWashed(active)).toBeGreaterThan(0);
    expect(washText(active)).not.toBe(washText(idle));
    expect(neutralActive).toHaveLength(0);
    expect(countTone(active, "you")).toBeGreaterThan(0);
    const strandsOnFloor = active.rows
      .flat()
      .filter((cell) => cell.tone === "you" && cell.wash !== undefined);
    expect(strandsOnFloor.length).toBeGreaterThan(0);
  });

  test("keeps speaker identity on its originating side", () => {
    const field = new SignalField({ seed: 3 });
    for (let i = 0; i < 30; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const frame = field.render(60, 5);
    expect(frame.dominant).toBe("you");
    expect(countTone(frame, "you")).toBeGreaterThan(0);
    expect(countTone(frame, "agent")).toBe(0);
    const left = frame.rows.flatMap((row) => row.slice(0, 20));
    const right = frame.rows.flatMap((row) => row.slice(40));
    expect(left.filter((cell) => cell.tone === "you").length).toBeGreaterThan(
      right.filter((cell) => cell.tone === "you").length,
    );
  });

  test("simultaneous voices share the field gently, with nothing marking the overlap", () => {
    const overlap = new SignalField({ seed: 19 });
    for (let i = 0; i < 40; i++) overlap.step(1 / 30, { you: 1, agent: 1 });
    const frame = overlap.render(64, 7);
    expect(frame.dominant).toBe("contact");
    expect(frame.contact).toBeGreaterThan(0.9);
    const voiceChars = new Set(
      frame.rows
        .flat()
        .filter((cell) => cell.tone !== "grid")
        .map((cell) => cell.char),
    );
    for (const clash of CLASH_GLYPHS) expect(voiceChars.has(clash)).toBe(false);
    expect(countTone(frame, "you")).toBeGreaterThan(0);
    expect(countTone(frame, "agent")).toBeGreaterThan(0);
    const tones = new Set(frame.rows.flat().map((cell) => cell.tone));
    expect(
      [...tones].every((tone) => ["faint", "dim", "grid", "you", "agent"].includes(tone)),
    ).toBe(true);
  });

  test("wash colors ramp smoothly up from the field base", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#131a1e", "#4b575e", 0)).toBe("#131a1e");
    const palette = { faint: "#4b575e" };
    const colors = new Set<string>();
    for (let step = 1; step <= WASH_STEPS; step++) {
      colors.add(signalFieldWashColor(step, "#131a1e", palette));
    }
    expect(colors.size).toBeGreaterThan(WASH_STEPS * 0.6);
  });

  test("graph paper rules the empty field, centered, and yields to strands", () => {
    const field = new SignalField({ seed: 23 });
    const idle = field.render(61, 7);
    expect(idle.rows[3]?.[30]).toMatchObject({ char: "╋", tone: "grid" });
    expect(idle.rows[2]?.[30]?.char).toBe("┃");
    expect(idle.rows[3]?.[31]?.char).toBe("━");
    expect(idle.rows[3]?.[24]?.char).toBe("┿");
    expect(idle.rows[0]?.[30]?.char).toBe("╂");
    expect(idle.rows[0]?.[24]?.char).toBe("┼");
    expect(idle.rows[1]?.[24]?.char).toBe("│");
    expect(idle.rows[0]?.[23]?.char).toBe("─");
    expect(idle.rows[1]?.[1]?.char).toBe(" ");
    const paperOnFloor = idle.rows
      .flat()
      .filter((cell) => cell.tone === "grid" && cell.wash !== undefined);
    expect(paperOnFloor.length).toBeGreaterThan(0);

    for (let i = 0; i < 30; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const loud = field.render(61, 7);
    expect(countTone(loud, "you")).toBeGreaterThan(0);
    expect(countTone(loud, "grid")).toBeGreaterThan(0);
    expect(countTone(loud, "grid")).toBeLessThan(countTone(idle, "grid"));
  });

  test("axes straddle the center boundary at even sizes, landing on the true pixel center", () => {
    const field = new SignalField({ seed: 23 });
    const even = field.render(60, 8);
    expect(even.rows[1]?.[29]?.char).toBe("▕");
    expect(even.rows[1]?.[30]?.char).toBe("▏");
    expect(even.rows[3]?.[7]?.char).toBe("▁");
    expect(even.rows[4]?.[7]?.char).toBe("▔");
    expect(even.rows[3]?.[29]?.char).toBe("▕");
    expect(even.rows[4]?.[30]?.char).toBe("▏");

    const evenHeightOnly = field.render(61, 8);
    expect(evenHeightOnly.rows[3]?.[30]?.char).toBe("┃");
    expect(evenHeightOnly.rows[3]?.[7]?.char).toBe("▁");

    const evenWidthOnly = field.render(60, 7);
    expect(evenWidthOnly.rows[3]?.[29]?.char).toBe("━");
    expect(evenWidthOnly.rows[2]?.[29]?.char).toBe("▕");
  });

  test("releases toward quiet instead of freezing the last loud frame", () => {
    const field = new SignalField({ seed: 5 });
    for (let i = 0; i < 20; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const loud = field.render(40, 4).you;
    for (let i = 0; i < 90; i++) field.step(1 / 30, { you: 0, agent: 0 });
    const quiet = field.render(40, 4);
    expect(loud).toBeGreaterThan(0.9);
    expect(quiet.you).toBeLessThan(0.01);
    expect(quiet.dominant).toBe("idle");
  });
});
