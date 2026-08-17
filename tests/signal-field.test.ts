import { describe, expect, test } from "bun:test";
import {
  mixHex,
  SignalField,
  signalFieldText,
  signalFieldWashColor,
  WASH_STEPS,
} from "../src/console/signal-field.ts";
import {
  boundedViewportExtent,
  boundedViewportSize,
  instrumentRuns,
  pttRowCount,
  styledInstrumentField,
} from "../src/console/signal-field-ui.ts";

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

  test("standby is a glyphless undulation, smooth in space and continuous in time", () => {
    for (const standby of ["swell", "pond", "weave"] as const) {
      const field = new SignalField({ seed: 41, standby });
      const initialFrame = field.render(72, 9);
      const area = 72 * 9;
      expect(signalFieldText(initialFrame).replaceAll("\n", "")).toBe(" ".repeat(area));
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
    const chars = new Set(signalFieldText(frame));
    for (const clash of CLASH_GLYPHS) expect(chars.has(clash)).toBe(false);
    expect(countTone(frame, "you")).toBeGreaterThan(0);
    expect(countTone(frame, "agent")).toBeGreaterThan(0);
    const tones = new Set(frame.rows.flat().map((cell) => cell.tone));
    expect([...tones].every((tone) => ["faint", "dim", "you", "agent"].includes(tone))).toBe(true);
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

  test("instrument runs place status, zone outlines, voice text, and push-to-talk", () => {
    const status = { text: "\u25cf LIVE 0:12", color: "#82cb9a" };
    const you = { muted: false, talking: false, color: "#e2b56f", db: Number.NEGATIVE_INFINITY };
    const agent = { muted: true, color: "#7fb9e8", db: -18.7 };
    const runs = instrumentRuns(60, 19, status, you, agent, true);
    const texts = runs.map((run) => run.text);
    expect(texts).toContain("YOU \u25b7 INPUT");
    expect(texts).toContain("AGENT \u00d7 MUTED");
    expect(texts).toContain("PUSH TO TALK");
    expect(texts).toContain(" / 48 KHZ");
    expect(texts).toContain("-\u221e  dB");
    expect(texts).toContain("-18.7 dB");
    expect(runs.find((run) => run.text === status.text)?.y).toBe(0);
    const ptt = runs.find((run) => run.text === "PUSH TO TALK");
    expect(pttRowCount(19)).toBe(5);
    expect(ptt?.y).toBe(19 - 5 + 2);
    const corners = runs.filter((run) => run.text.startsWith("\u256d"));
    expect(corners).toHaveLength(3);

    const narrow = instrumentRuns(40, 19, status, you, agent, true).map((run) => run.text);
    expect(narrow).not.toContain(" / 48 KHZ");

    const talking = instrumentRuns(60, 19, status, { ...you, talking: true }, agent, true).map(
      (run) => run.text,
    );
    expect(talking).toContain("YOU \u25cf TALKING");
    expect(talking).toContain("\u25cf TALKING");

    const mutedMic = instrumentRuns(60, 19, status, { ...you, muted: true }, agent, true).map(
      (run) => run.text,
    );
    expect(mutedMic).toContain("YOU \u00d7 PUSH");
    expect(mutedMic).not.toContain("YOU \u00d7 MUTED");

    const collapsed = instrumentRuns(60, 19, status, you, agent, false);
    const collapsedTexts = collapsed.map((run) => run.text);
    expect(collapsedTexts).not.toContain("PUSH TO TALK");
    expect(collapsed.filter((run) => run.text.startsWith("\u256d"))).toHaveLength(2);
    expect(collapsed.some((run) => run.y === 18 && run.text.startsWith("\u2570"))).toBe(true);
  });

  test("a muted voice keeps animating in its own hue, dashed", () => {
    const field = new SignalField({ seed: 11 });
    for (let i = 0; i < 12; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const frame = field.render(60, 7, { you: true });
    expect(countTone(frame, "you")).toBeGreaterThan(0);
    expect(countTone(frame, "dim")).toBe(0);
    const strandChars = frame.rows
      .flat()
      .filter((cell) => cell.tone === "you")
      .map((cell) => cell.char);
    expect(strandChars.every((char) => ["·", "┄", "┈"].includes(char))).toBe(true);
  });

  test("instrument runs float over the field at their cells", () => {
    const field = new SignalField({ seed: 23 });
    const frame = field.render(40, 7);
    const styled = styledInstrumentField(
      frame,
      { faint: "#4b575e", dim: "#7d8a91", you: "#e2b56f", agent: "#7fb9e8" },
      [
        { x: 0, y: 0, text: "TOP", color: "#e2b56f", bold: true },
        { x: 18, y: 3, text: "MID", color: "#d8e2e7" },
        { x: 37, y: 6, text: "END", color: "#7fb9e8" },
      ],
    );
    const rows = styled.chunks
      .map((chunk) => chunk.text)
      .join("")
      .split("\n");
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.length === 40)).toBe(true);
    expect(rows[0]?.startsWith("TOP")).toBe(true);
    expect(rows[3]?.slice(18, 21)).toBe("MID");
    expect(rows[6]?.endsWith("END")).toBe(true);
    expect(rows[1]).toBe(signalFieldText(frame).split("\n")[1]);
  });

  test("outline runs flow with the field instead of framing it rigidly", () => {
    const colors = { faint: "#4b575e", dim: "#7d8a91", you: "#e2b56f", agent: "#7fb9e8" };
    const run = [{ x: 0, y: 2, text: "─".repeat(48), color: "#4b575e", flow: true }];
    const field = new SignalField({ seed: 41 });
    const idleRows = styledInstrumentField(field.render(48, 5), colors, run)
      .chunks.map((chunk) => chunk.text)
      .join("")
      .split("\n");
    const idleLine = idleRows[2] ?? "";
    expect([...idleLine].every((char) => ["┄", "╌", "─", "━"].includes(char))).toBe(true);
    expect(new Set(idleLine).size).toBeGreaterThan(1);

    for (let i = 0; i < 30; i++) field.step(1 / 30, { you: 1, agent: 0 });
    const loudRows = styledInstrumentField(field.render(48, 5), colors, run)
      .chunks.map((chunk) => chunk.text)
      .join("")
      .split("\n");
    expect(loudRows[2]?.includes("━")).toBe(true);
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
