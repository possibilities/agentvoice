import { describe, expect, test } from "bun:test";
import { SignalField, signalFieldText } from "../src/console/signal-field.ts";
import { boundedViewportExtent, boundedViewportSize } from "../src/console/signal-field-ui.ts";

function countTone(field: ReturnType<SignalField["render"]>, tone: string): number {
  return field.rows.flat().filter((cell) => cell.tone === tone).length;
}

function countOccupied(field: ReturnType<SignalField["render"]>): number {
  return field.rows.flat().filter((cell) => cell.char !== " ").length;
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

  test("idle has sparse raked contours that drift instead of flickering", () => {
    const field = new SignalField({ seed: 41 });
    const initialFrame = field.render(72, 9);
    const initial = signalFieldText(initialFrame);
    const area = 72 * 9;
    expect(countOccupied(initialFrame)).toBeGreaterThan(area * 0.18);
    expect(countOccupied(initialFrame)).toBeLessThan(area * 0.5);
    expect(new Set(initial.replaceAll("\n", ""))).toEqual(new Set([" ", "·", "╴", "─", "┄", "┈"]));

    for (let i = 0; i < 6; i++) field.step(1 / 30, { you: 0, agent: 0 });
    const soon = signalFieldText(field.render(72, 9));
    expect(changedCells(initial, soon)).toBeLessThan(area * 0.04);

    for (let i = 0; i < 150; i++) field.step(1 / 30, { you: 0, agent: 0 });
    const later = signalFieldText(field.render(72, 9));
    expect(changedCells(initial, later)).toBeGreaterThan(area * 0.015);
  });

  test("voice onset clears the idle grooves", () => {
    const field = new SignalField({ seed: 11 });
    const idle = field.render(60, 7);
    for (let i = 0; i < 12; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const active = field.render(60, 7);
    const neutralActive = active.rows
      .flat()
      .filter((cell) => cell.char !== " " && (cell.tone === "faint" || cell.tone === "dim"));
    expect(countOccupied(idle)).toBeGreaterThan(0);
    expect(neutralActive).toHaveLength(0);
    expect(countTone(active, "you")).toBeGreaterThan(0);
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

  test("overlap creates a visible contact fault", () => {
    const solo = new SignalField({ seed: 19 });
    const overlap = new SignalField({ seed: 19 });
    for (let i = 0; i < 40; i++) {
      solo.step(1 / 30, { you: 1, agent: 0 });
      overlap.step(1 / 30, { you: 1, agent: 1 });
    }
    const soloFrame = solo.render(64, 7);
    const overlapFrame = overlap.render(64, 7);
    expect(overlapFrame.dominant).toBe("contact");
    expect(overlapFrame.contact).toBeGreaterThan(0.9);
    expect(countTone(overlapFrame, "contact")).toBeGreaterThan(countTone(soloFrame, "contact"));
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
