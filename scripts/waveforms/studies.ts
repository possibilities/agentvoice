import { type Ink, Raster, type RasterMode } from "./raster.ts";

export interface Parameters {
  speed: number;
  amplitude: number;
  frequency: number;
}

export const defaults = (): Parameters => ({ speed: 1, amplitude: 1, frequency: 1 });
export const limits = {
  speed: [0.25, 3, 0.25],
  amplitude: [0.25, 1.75, 0.125],
  frequency: [0.25, 3, 0.25],
} as const;

interface Study {
  id: string;
  name: string;
  description: string;
  mode: RasterMode;
  draw(r: Raster, time: number, p: Parameters): void;
}

const tau = Math.PI * 2;
const ink = (value: number): Ink => Math.max(0, Math.min(5, Math.ceil(value * 5))) as Ink;
const bell = (x: number, center: number, width: number) => Math.exp(-(((x - center) / width) ** 2));
const wave = (x: number, t: number, f: number) =>
  Math.sin(tau * x * 2.5 * f - t * 1.8) * 0.63 +
  Math.sin(tau * x * 6 * f + t * 1.1) * 0.23 +
  Math.sin(tau * x * 11 * f - t * 0.7) * 0.14;

function trace(r: Raster, fn: (x: number) => number, level: Ink = 5): void {
  r.curve((x) => [x * (r.width - 1), (0.5 - fn(x) * 0.43) * (r.height - 1)], level);
}

function orbit(r: Raster, fn: (a: number) => readonly [number, number], level: Ink = 5): void {
  const radius = Math.min(r.width - 1, r.height - 1) * 0.43;
  r.curve(
    (u) => {
      const [x, y] = fn(u * tau);
      return [(r.width - 1) / 2 + x * radius, (r.height - 1) / 2 + y * radius];
    },
    level,
    Math.min(1200, r.width * 5),
  );
}

export const studies: readonly Study[] = [
  {
    id: "phosphor",
    name: "Phosphor scope",
    mode: "braille",
    description: "A restless signal, held in five fading traces.",
    draw(r, t, p) {
      for (let age = 4; age >= 0; age--)
        trace(r, (x) => wave(x, t - age * 0.16, p.frequency) * p.amplitude, (5 - age) as Ink);
    },
  },
  {
    id: "braid",
    name: "Braided harmonics",
    mode: "braille",
    description: "Five oscillators weaving through one another.",
    draw(r, t, p) {
      for (let strand = 0; strand < 5; strand++)
        trace(
          r,
          (x) =>
            Math.sin(x * tau * 1.6 * p.frequency - t + (strand * tau) / 5) *
            Math.sin(x * Math.PI + t * 0.18) *
            p.amplitude *
            0.9,
          (strand + 1) as Ink,
        );
    },
  },
  {
    id: "envelope",
    name: "Mirrored envelope",
    mode: "blocks",
    description: "Soft bursts folding around a silent center.",
    draw(r, t, p) {
      for (let x = 0; x < r.width; x++) {
        const u = x / Math.max(1, r.width - 1);
        const envelope =
          (bell(u, 0.3 + Math.sin(t * 0.7) * 0.12, 0.16) +
            bell(u, 0.73 + Math.cos(t * 0.45) * 0.09, 0.12)) *
          0.85;
        const value = (0.3 + Math.abs(wave(u, t, p.frequency)) * 0.7) * envelope * p.amplitude;
        for (let y = 0; y < r.height; y++) {
          // Area coverage preserves thin envelopes even in a one-row preview.
          const low = (y / r.height) * 2 - 1;
          const high = ((y + 1) / r.height) * 2 - 1;
          const coverage =
            (Math.max(0, Math.min(high, value) - Math.max(low, -value)) * r.height) / 2;
          const d = Math.abs((low + high) / 2);
          if (coverage > 0.025)
            r.point(x, y, ink((0.25 + 0.75 * Math.min(1, d / Math.max(0.01, value))) * coverage));
        }
      }
    },
  },
  {
    id: "fm",
    name: "FM ribbon",
    mode: "braille",
    description: "A slow wave bends the frequency of a faster one.",
    draw(r, t, p) {
      for (let ribbon = 4; ribbon >= 0; ribbon--)
        trace(
          r,
          (x) =>
            Math.sin(x * tau * 3 * p.frequency + 3 * Math.sin(x * tau - t) + ribbon * 0.13) *
            (0.65 + 0.2 * Math.sin(x * tau + t)) *
            p.amplitude,
          (5 - ribbon) as Ink,
        );
    },
  },
  {
    id: "lissajous",
    name: "Lissajous loops",
    mode: "braille",
    description: "Two frequencies drawing a slowly turning knot.",
    draw(r, t, p) {
      for (let age = 4; age >= 0; age--) {
        const phase = t * 0.35 - age * 0.045;
        orbit(
          r,
          (a) => [
            Math.sin(a * 3 + phase) * p.amplitude,
            Math.sin(a * 2 * p.frequency + phase * 0.4) * p.amplitude,
          ],
          (5 - age) as Ink,
        );
      }
    },
  },
  {
    id: "rose",
    name: "Phase rose",
    mode: "braille",
    description: "Petals opening as the phase drifts through a circle.",
    draw(r, t, p) {
      for (let age = 3; age >= 0; age--) {
        const phase = t * 0.23 - age * 0.04;
        orbit(
          r,
          (a) => {
            const radius =
              (0.5 + 0.48 * Math.cos(a * (4 + p.frequency * 2) + phase * 3)) * p.amplitude;
            return [Math.cos(a + phase) * radius, Math.sin(a + phase) * radius];
          },
          (5 - age) as Ink,
        );
      }
    },
  },
  {
    id: "radial",
    name: "Radial pulses",
    mode: "braille",
    description: "Ripples travel outward through a breathing membrane.",
    draw(r, t, p) {
      const rings = Math.max(3, Math.min(7, Math.floor(r.height / 7)));
      for (let ring = 0; ring < rings; ring++) {
        const radius = (((ring / rings + t * 0.09) % 1) + 1) % 1;
        orbit(
          r,
          (a) => {
            const ripple =
              radius * (0.88 + 0.08 * Math.sin(a * 8 * p.frequency - t * 2)) * p.amplitude;
            return [Math.cos(a) * ripple, Math.sin(a) * ripple];
          },
          ink(1 - radius * 0.82),
        );
      }
    },
  },
  {
    id: "standing",
    name: "Standing waves",
    mode: "braille",
    description: "Opposing waves leave fixed nodes and moving antinodes.",
    draw(r, t, p) {
      for (let age = 4; age >= 0; age--)
        trace(
          r,
          (x) => Math.sin(x * tau * 3 * p.frequency) * Math.cos(t * 2 - age * 0.14) * p.amplitude,
          (5 - age) as Ink,
        );
    },
  },
  {
    id: "interference",
    name: "Interference field",
    mode: "blocks",
    description: "Two moving sources meet in bands of light and silence.",
    draw(r, t, p) {
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.width; x++) {
          const u = (x / r.width) * 3 - 1.5;
          const v = (y / r.height) * 2 - 1;
          const d1 = Math.hypot(u + 0.55, v + Math.sin(t * 0.3) * 0.35);
          const d2 = Math.hypot(u - 0.55, v - Math.cos(t * 0.4) * 0.35);
          const value =
            (Math.sin(d1 * 13 * p.frequency - t * 2) + Math.sin(d2 * 13 * p.frequency - t * 2)) / 2;
          r.point(x, y, ink(Math.max(0, value * p.amplitude) ** 1.6));
        }
    },
  },
  {
    id: "waterfall",
    name: "Waveform waterfall",
    mode: "braille",
    description: "A signal leaves a receding landscape of its own history.",
    draw(r, t, p) {
      const layers = Math.max(4, Math.min(14, Math.floor(r.height / 5)));
      for (let layer = 0; layer < layers; layer++) {
        const depth = layer / (layers - 1);
        r.curve(
          (x) => {
            const value = wave(x, t - (1 - depth) * 2.6, p.frequency) * Math.sin(Math.PI * x);
            return [
              (0.08 + x * 0.84 + (1 - depth) * 0.065) * (r.width - 1),
              (0.12 + depth * 0.74 - value * 0.16 * p.amplitude) * (r.height - 1),
            ];
          },
          ink(0.18 + depth * 0.82),
        );
      }
    },
  },
  {
    id: "spectrum",
    name: "Spectrum ridges",
    mode: "blocks",
    description: "Synthetic harmonic peaks rise, drift, and decay.",
    draw(r, t, p) {
      for (let x = 0; x < r.width; x++) {
        if (x % 3 === 2) continue;
        const u = (Math.floor(x / 3) * 3) / r.width;
        const peaks =
          bell(u, 0.2 + Math.sin(t * 0.4) * 0.07, 0.1 / p.frequency) +
          bell(u, 0.5 + Math.sin(t * 0.65) * 0.13, 0.13 / p.frequency) * 0.8 +
          bell(u, 0.81, 0.09 / p.frequency) * (0.45 + Math.sin(t) * 0.25);
        const height = Math.min(1, peaks * p.amplitude * (0.8 + 0.15 * Math.sin(u * 70 + t * 3)));
        for (let y = 0; y < r.height; y++) {
          const level = 1 - y / Math.max(1, r.height - 1);
          if (level <= height) r.point(x, y, ink(0.2 + level * 0.8));
        }
      }
    },
  },
  {
    id: "particles",
    name: "Particle trails",
    mode: "braille",
    description: "Points surf a changing wave, leaving threads behind.",
    draw(r, t, p) {
      for (let particle = 0; particle < 42; particle++) {
        const velocity = 0.055 + (particle % 5) * 0.008;
        for (let age = 4; age >= 0; age--) {
          const past = t - age * 0.09;
          const u = (((particle / 42 + past * velocity) % 1) + 1) % 1;
          const v =
            Math.sin(u * tau * 2 * p.frequency - past * 0.7 + (particle % 3)) *
            (0.3 + 0.5 * Math.sin(u * Math.PI)) *
            p.amplitude;
          r.point(u * (r.width - 1), (0.5 - v * 0.44) * (r.height - 1), (5 - age) as Ink);
        }
      }
    },
  },
];

export function renderStudy(
  index: number,
  columns: number,
  rows: number,
  time: number,
  p: Parameters,
): Raster {
  const study = studies[index];
  if (!study) throw new Error("Unknown waveform study");
  if (!Number.isFinite(time) || Object.values(p).some((v) => !Number.isFinite(v)))
    throw new Error("Waveform parameters must be finite");
  const raster = new Raster(columns, rows, study.mode);
  study.draw(raster, time, p);
  return raster;
}
