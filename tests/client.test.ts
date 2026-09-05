import { describe, expect, test } from "bun:test";
import {
  FRAME_SAMPLES,
  formatClock,
  levelFromDb,
  rmsDbS16,
  SAMPLE_RATE,
} from "../src/console/dsp.ts";

describe("frame constants", () => {
  test("one frame is 20ms at the session rate", () => {
    expect(FRAME_SAMPLES / SAMPLE_RATE).toBeCloseTo(0.02);
  });
});

describe("rms", () => {
  test("measures signed PCM silence and half-scale volume", () => {
    expect(rmsDbS16(Buffer.alloc(200))).toBe(-Infinity);
    expect(rmsDbS16(Buffer.alloc(0))).toBe(-Infinity);
    const s16 = Buffer.alloc(192);
    for (let i = 0; i < 96; i++) s16.writeInt16LE(i % 2 === 0 ? 16384 : -16384, i * 2);
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

describe("formatClock", () => {
  test("renders mm:ss and grows to hours", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_000)).toBe("59:59");
    expect(formatClock(3_661_000)).toBe("1:01:01");
    expect(formatClock(-5_000)).toBe("00:00");
  });
});
