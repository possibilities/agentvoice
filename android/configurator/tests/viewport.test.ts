import { expect, test } from "bun:test";
import { parseViewport } from "../src/viewport.ts";

test("optional viewport measurements are bounded, exact and not fabricated", () => {
  const measurement = {
    width: 1080,
    height: 2340,
    systemBars: { left: 0, top: 80, right: 0, bottom: 100 },
    cutouts: [{ left: 500, top: 0, right: 580, bottom: 75 }],
  };
  expect(parseViewport(measurement)).toEqual(measurement);
  for (const bad of [
    undefined,
    null,
    {},
    { ...measurement, width: 0 },
    { ...measurement, width: 2.5 },
    { ...measurement, extra: true },
    { ...measurement, cutouts: Array(17).fill(measurement.cutouts[0]) },
    { ...measurement, cutouts: [{ left: 500, top: 0, right: 400, bottom: 75 }] },
    { ...measurement, systemBars: { left: 600, top: 0, right: 600, bottom: 0 } },
    { ...measurement, systemBars: { left: -1, top: 0, right: 0, bottom: 0 } },
  ])
    expect(parseViewport(bad)).toBeUndefined();
});
