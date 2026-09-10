export type PixelRect = { left: number; top: number; right: number; bottom: number };
export type CaptureViewport = {
  width: number;
  height: number;
  systemBars: PixelRect;
  cutouts: PixelRect[];
};

/** Optional measurement: invalid or missing metadata never becomes an invented safe area. */
export function parseViewport(value: unknown): CaptureViewport | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "cutouts,height,systemBars,width") return undefined;
    const width = dimension(item["width"]),
      height = dimension(item["height"]);
    const systemBars = rect(item["systemBars"], width, height);
    if (systemBars.left + systemBars.right > width || systemBars.top + systemBars.bottom > height)
      return undefined;
    if (!Array.isArray(item["cutouts"]) || item["cutouts"].length > 16) return undefined;
    const cutouts = item["cutouts"].map((value) => rect(value, width, height));
    if (cutouts.some((value) => value.left >= value.right || value.top >= value.bottom))
      return undefined;
    return { width, height, systemBars, cutouts };
  } catch {
    return undefined;
  }
}
function dimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8192)
    throw Error();
  return value;
}
function rect(value: unknown, width: number, height: number): PixelRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "bottom,left,right,top") throw Error();
  for (const key of ["left", "top", "right", "bottom"]) {
    const number = item[key];
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 0 ||
      number > (key === "left" || key === "right" ? width : height)
    )
      throw Error();
  }
  return {
    left: item["left"] as number,
    top: item["top"] as number,
    right: item["right"] as number,
    bottom: item["bottom"] as number,
  };
}
