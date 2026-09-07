import { describe, expect, test } from "bun:test";
import { FRAME_SAMPLES, rmsDbS16, SAMPLE_RATE } from "../src/console/dsp.ts";

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
