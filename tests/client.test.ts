import { describe, expect, test } from "bun:test";
import {
  barString,
  FRAME_SAMPLES,
  floatToS16,
  formatClock,
  levelFromDb,
  rmsDbFloat,
  rmsDbS16,
  SAMPLE_RATE,
  shortId,
  sparkline,
} from "../src/client/dsp.ts";

describe("frame constants", () => {
  test("one frame is 20ms at the session rate", () => {
    expect(FRAME_SAMPLES / SAMPLE_RATE).toBeCloseTo(0.02);
  });
});

describe("floatToS16", () => {
  test("converts and clamps", () => {
    const out = floatToS16(new Float32Array([0, 0.5, 1, -1, 2, -2]));
    expect(out.length).toBe(12);
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(2)).toBe(16384);
    expect(out.readInt16LE(4)).toBe(32767);
    expect(out.readInt16LE(6)).toBe(-32767);
    expect(out.readInt16LE(8)).toBe(32767);
    expect(out.readInt16LE(10)).toBe(-32767);
  });
});

describe("rms", () => {
  test("silence is -Infinity in both domains", () => {
    expect(rmsDbFloat(new Float32Array(100))).toBe(-Infinity);
    expect(rmsDbS16(Buffer.alloc(200))).toBe(-Infinity);
    expect(rmsDbFloat(new Float32Array(0))).toBe(-Infinity);
  });

  test("full-scale square wave is ~0 dBFS, half scale ~-6 dB", () => {
    const full = new Float32Array(96).fill(1);
    expect(rmsDbFloat(full)).toBeCloseTo(0, 3);
    const half = new Float32Array(96).fill(0.5);
    expect(rmsDbFloat(half)).toBeCloseTo(-6.02, 1);
    const s16 = floatToS16(half);
    expect(rmsDbS16(s16)).toBeCloseTo(-6.02, 1);
  });
});

describe("levelFromDb", () => {
  test("maps the floor..0 range onto 0..1 and clamps", () => {
    expect(levelFromDb(-Infinity)).toBe(0);
    expect(levelFromDb(-60)).toBe(0);
    expect(levelFromDb(-30)).toBeCloseTo(0.5);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(10)).toBe(1);
    expect(levelFromDb(-90)).toBe(0);
  });
});

describe("meter rendering", () => {
  test("barString is always exactly width chars", () => {
    for (const level of [0, 0.01, 0.33, 0.5, 0.99, 1]) {
      expect(barString(level, 20).length).toBe(20);
    }
    expect(barString(0, 10)).toBe(" ".repeat(10));
    expect(barString(1, 10)).toBe("█".repeat(10));
  });

  test("barString grows monotonically", () => {
    let previous = "";
    for (let level = 0; level <= 1.0001; level += 0.05) {
      const bar = barString(level, 16);
      const fill = (bar.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length;
      const previousFill = (previous.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length;
      expect(fill).toBeGreaterThanOrEqual(previousFill);
      previous = bar;
    }
  });

  test("sparkline right-aligns and windows history", () => {
    expect(sparkline([], 8)).toBe(" ".repeat(8));
    expect(sparkline([1], 4)).toBe("   █");
    const line = sparkline([0, 0.25, 0.5, 0.75, 1], 3);
    expect(line.length).toBe(3);
    expect(line.at(-1)).toBe("█");
  });
});

describe("formatClock", () => {
  test("renders mm:ss and grows to hours", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_000)).toBe("59:59");
    expect(formatClock(3_661_000)).toBe("1:01:01");
    expect(formatClock(-5_000)).toBe("00:00");
  });
});

describe("shortId", () => {
  test("truncates long ids only", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("012345678")).toBe("012345678");
    expect(shortId("0123456789abcdef")).toBe("01234567…");
  });
});
