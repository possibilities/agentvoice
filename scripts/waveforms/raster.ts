export type Ink = 0 | 1 | 2 | 3 | 4 | 5;
export type RasterMode = "braille" | "blocks";

const dots = [1, 8, 2, 16, 4, 32, 64, 128];

/** Subcell samples carry one of the five fxnk ramp steps, never arbitrary colors. */
export class Raster {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(
    readonly columns: number,
    readonly rows: number,
    readonly mode: RasterMode = "braille",
  ) {
    if (
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 1 ||
      rows < 1 ||
      columns > 240 ||
      rows > 100
    )
      throw new Error("Raster dimensions must be 1–240 by 1–100 cells");
    this.width = columns * (mode === "braille" ? 2 : 1);
    this.height = rows * (mode === "braille" ? 4 : 2);
    this.pixels = new Uint8Array(this.width * this.height);
  }

  point(x: number, y: number, ink: Ink = 5): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const i = y * this.width + x;
    if (ink > this.pixels[i]!) this.pixels[i] = ink;
  }

  line(x0: number, y0: number, x1: number, y1: number, ink: Ink = 5): void {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    // Bound even off-screen segments; formulas never get to monopolize a frame.
    const steps = Math.min(
      this.width + this.height,
      Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))),
    );
    if (!steps) {
      this.point(x0, y0, ink);
      return;
    }
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.point(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ink);
    }
  }

  curve(
    sample: (t: number) => readonly [number, number],
    ink: Ink = 5,
    samples = this.width * 2,
  ): void {
    let previous = sample(0);
    for (let i = 1; i <= samples; i++) {
      const next = sample(i / samples);
      this.line(previous[0], previous[1], next[0], next[1], ink);
      previous = next;
    }
  }

  cell(x: number, y: number): { char: string; ink: Ink; lower: Ink } {
    if (this.mode === "blocks") {
      const upper = this.pixels[y * 2 * this.width + x] as Ink;
      const lower = this.pixels[(y * 2 + 1) * this.width + x] as Ink;
      return {
        char: upper ? "▀" : lower ? "▄" : " ",
        ink: upper || lower,
        lower: upper ? lower : 0,
      };
    }
    let mask = 0;
    let brightest: Ink = 0;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const ink = this.pixels[(y * 4 + dy) * this.width + x * 2 + dx] as Ink;
        if (ink) mask |= dots[dy * 2 + dx]!;
        if (ink > brightest) brightest = ink;
      }
    }
    return { char: mask ? String.fromCharCode(0x2800 + mask) : " ", ink: brightest, lower: 0 };
  }
}
