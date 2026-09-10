import { expect, test } from "bun:test";
import { compactCaptureLayout, usableViewport } from "../src/capture-layout.ts";

const frames = [
  { orientation: "landscape", width: 1560, height: 720 },
  { orientation: "portrait-reverse", width: 720, height: 1560 },
  { orientation: "landscape-reverse", width: 1560, height: 720 },
  { orientation: "portrait", width: 720, height: 1560 },
] as const;

test("compact capture layout orders physical orientations with one scale", () => {
  const layout = compactCaptureLayout(frames)!;
  expect(layout.frames.map((frame) => frame.orientation)).toEqual([
    "portrait",
    "portrait-reverse",
    "landscape",
    "landscape-reverse",
  ]);
  expect(layout.width).toBeLessThanOrEqual(840);
  expect(layout.height).toBeLessThanOrEqual(460);
  const portrait = layout.frames[0]!;
  const landscape = layout.frames[2]!;
  expect(portrait.height / 1560).toBeCloseTo(landscape.width / 1560);
  for (const placement of layout.frames) {
    const source = frames.find((frame) => frame.orientation === placement.orientation)!;
    expect(placement.width / source.width).toBeCloseTo(layout.scale);
    expect(placement.height / source.height).toBeCloseTo(layout.scale);
    expect(placement.cardHeight).toBeCloseTo(placement.height + placement.captionHeight);
  }
  expect(layout.frames[1]!.left).toBeGreaterThan(portrait.left);
  expect(layout.frames[3]!.top).toBeGreaterThan(landscape.top);
});

test("only screenshot-aligned viewport metadata is usable", () => {
  const frame = {
    orientation: "portrait" as const,
    width: 720,
    height: 1560,
    viewport: {
      width: 720,
      height: 1560,
      systemBars: { left: 0, top: 80, right: 0, bottom: 120 },
      cutouts: [{ left: 300, top: 0, right: 420, bottom: 80 }],
    },
  };
  expect(usableViewport(frame)).toEqual(frame.viewport);
  expect(usableViewport({ ...frame, viewport: { ...frame.viewport, width: 719 } })).toBeUndefined();
});
