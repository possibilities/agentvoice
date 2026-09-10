import type { CaptureViewport } from "./viewport.ts";

export const captureFrameOrder = [
  "portrait",
  "portrait-reverse",
  "landscape",
  "landscape-reverse",
] as const;
export type CaptureOrientation = (typeof captureFrameOrder)[number];
export type CaptureFrame = {
  orientation: CaptureOrientation;
  width: number;
  height: number;
  viewport?: CaptureViewport;
};
export type CapturePlacement = {
  orientation: CaptureOrientation;
  left: number;
  top: number;
  width: number;
  height: number;
  captionHeight: number;
  cardHeight: number;
};
export type CaptureLayout = {
  width: number;
  height: number;
  scale: number;
  frames: CapturePlacement[];
};

const portraitOrder = ["portrait", "portrait-reverse"] as const;
const landscapeOrder = ["landscape", "landscape-reverse"] as const;
const innerGap = 20;
const columnGap = 24;
const captionHeight = 28;

/** One scale keeps physical UI details comparable across all four rotations. */
export function compactCaptureLayout(
  frames: readonly CaptureFrame[],
  maximum = { width: 840, height: 460 },
): CaptureLayout | undefined {
  const byOrientation = new Map(frames.map((frame) => [frame.orientation, frame]));
  const portrait = portraitOrder.map((orientation) => byOrientation.get(orientation));
  const landscape = landscapeOrder.map((orientation) => byOrientation.get(orientation));
  if ([...portrait, ...landscape].some((frame) => !frame)) return undefined;
  const portraits = portrait as CaptureFrame[];
  const landscapes = landscape as CaptureFrame[];
  if (
    [...portraits, ...landscapes].some(
      (frame) =>
        !Number.isFinite(frame.width) ||
        !Number.isFinite(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0,
    )
  )
    return undefined;
  const sourcePortraitWidth = portraits.reduce((total, frame) => total + frame.width, 0);
  const sourcePortraitHeight = Math.max(...portraits.map((frame) => frame.height));
  const sourceLandscapeWidth = Math.max(...landscapes.map((frame) => frame.width));
  const sourceLandscapeHeight = landscapes.reduce((total, frame) => total + frame.height, 0);
  const scale = Math.min(
    (maximum.width - innerGap - columnGap) / (sourcePortraitWidth + sourceLandscapeWidth),
    (maximum.height - captionHeight) / sourcePortraitHeight,
    (maximum.height - innerGap - captionHeight * landscapes.length) / sourceLandscapeHeight,
  );
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const framesOut: CapturePlacement[] = [];
  let portraitX = 0;
  for (const frame of portraits) {
    const width = frame.width * scale;
    const height = frame.height * scale;
    framesOut.push({
      orientation: frame.orientation,
      left: portraitX,
      top: 0,
      width,
      height,
      captionHeight,
      cardHeight: height + captionHeight,
    });
    portraitX += width + innerGap;
  }
  const landscapeX = portraitX - innerGap + columnGap;
  let landscapeY = 0;
  for (const frame of landscapes) {
    const height = frame.height * scale;
    const cardHeight = height + captionHeight;
    framesOut.push({
      orientation: frame.orientation,
      left: landscapeX,
      top: landscapeY,
      width: frame.width * scale,
      height,
      captionHeight,
      cardHeight,
    });
    landscapeY += cardHeight + innerGap;
  }
  return {
    width: Math.max(...framesOut.map((frame) => frame.left + frame.width)),
    height: Math.max(...framesOut.map((frame) => frame.top + frame.cardHeight)),
    scale,
    frames: framesOut,
  };
}

/** Coordinates must describe the screenshot itself before the browser draws a guide. */
export function usableViewport(frame: CaptureFrame): CaptureViewport | undefined {
  const viewport = frame.viewport;
  return viewport?.width === frame.width && viewport.height === frame.height ? viewport : undefined;
}
