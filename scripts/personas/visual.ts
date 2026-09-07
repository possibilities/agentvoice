import { type Ink, Raster } from "../waveforms/raster.ts";
import { type AudioFrame, clamp, type PersonaAudio, silence } from "./audio.ts";

export const personaStates = ["idle", "listening", "thinking", "speaking", "asleep"] as const;
export type PersonaState = (typeof personaStates)[number];
export const variants = [
  {
    id: "waterfall",
    name: "Waveform waterfall",
    detail: "Speech leaves a landscape of fading ridges.",
  },
  { id: "phosphor", name: "Phosphor scope", detail: "The voice itself, suspended in phosphor." },
  {
    id: "braid",
    name: "Braided harmonics",
    detail: "Five frequency bands weave independent strands.",
  },
  { id: "fm", name: "FM ribbon", detail: "Vocal brightness folds a ribbon into finer waves." },
  { id: "rose", name: "Phase rose", detail: "Petals open with speech and gather while thinking." },
  { id: "radial", name: "Radial pulses", detail: "Syllable attacks release rings into the quiet." },
  {
    id: "standing",
    name: "Standing waves",
    detail: "Resonant bands swell between anchored nodes.",
  },
  {
    id: "lissajous",
    name: "Lissajous loops",
    detail: "A voice bends the phase and tension of a knot.",
  },
] as const;
export type PersonaVariant = (typeof variants)[number]["id"];
export const stateGlyph: Record<PersonaState, string> = {
  idle: "○",
  listening: "◉",
  thinking: "◐",
  speaking: "●",
  asleep: "·",
};

interface Trace {
  wave: Float32Array;
  bands: Float32Array;
  level: number;
}

class Channel {
  frame: AudioFrame | undefined;
  age = 0;
  attack = false;

  update(frame: AudioFrame | undefined, dt: number): void {
    const fresh =
      frame !== undefined &&
      (frame.stream !== this.frame?.stream || frame.revision !== this.frame?.revision);
    this.attack = !!(
      fresh &&
      frame.onsetRevision > 0 &&
      frame.revision - frame.onsetRevision <= 5 &&
      (frame.stream !== this.frame?.stream || frame.onsetRevision !== this.frame?.onsetRevision)
    );
    if (fresh) {
      this.frame = frame;
      this.age = 0;
    } else this.age += dt;
  }
}

/** One clock and bounded history can drive many variants and sizes in lockstep. */
export class PersonaMotion {
  state: PersonaState = "idle";
  audio: PersonaAudio = {};
  time = 0;
  phase = 0;
  level = 0;
  centroid = 0;
  pulse = 0;
  wave = new Float32Array(128);
  bands = new Float32Array(16);
  weights = [1, 0, 0, 0, 0];
  history: Trace[] = [];
  rings: Array<{ age: number; strength: number }> = [];
  private input = new Channel();
  private output = new Channel();
  private targetLevel = 0;
  private historyTime = 0;
  private quiet = silence();

  /** A paused scrub or initial paint should show the selected pose immediately. */
  settle(): void {
    this.weights = personaStates.map((state) => (state === this.state ? 1 : 0));
    this.advance(0);
    this.level = this.targetLevel;
  }

  advance(seconds: number): void {
    const dt = clamp(seconds, 0, 0.1);
    this.time += dt;
    const index = personaStates.indexOf(this.state);
    const blend = 1 - Math.exp(-dt / 0.16);
    this.weights = this.weights.map(
      (weight, i) => weight + ((index === i ? 1 : 0) - weight) * blend,
    );
    this.phase +=
      dt *
      (0.25 * this.weights[0]! +
        0.5 * this.weights[1]! +
        1.8 * this.weights[2]! +
        0.7 * this.weights[3]!);
    this.input.update(this.audio.input, dt);
    this.output.update(this.audio.output, dt);
    const channel = this.state === "listening" ? this.input : this.output;
    const frame =
      (this.state === "listening"
        ? this.audio.input
        : this.state === "speaking"
          ? this.audio.output
          : undefined) ?? this.quiet;
    if (frame !== this.quiet && channel.attack && clamp(frame.onset) > 0.12) {
      this.rings.push({ age: 0, strength: clamp(frame.onset) });
      if (this.rings.length > 12) this.rings.shift();
      this.pulse = Math.max(this.pulse, clamp(frame.onset));
    }
    const freshness = Math.exp(-Math.max(0, channel.age - 0.12) * 12);
    const target = clamp(frame.level) * freshness;
    this.targetLevel = target;
    this.level +=
      (target - this.level) * (1 - Math.exp(-dt / (target > this.level ? 0.025 : 0.12)));
    this.centroid += (clamp(frame.centroid) - this.centroid) * blend;
    for (let i = 0; i < this.wave.length; i++)
      this.wave[i] =
        clamp(
          (frame.waveform[i % Math.max(1, frame.waveform.length)] ?? 0) /
            Math.max(0.025, clamp(frame.peak)),
          -1,
          1,
        ) * freshness;
    for (let i = 0; i < this.bands.length; i++)
      this.bands[i] = clamp(frame.bands[i] ?? 0) * freshness;
    this.pulse *= Math.exp(-dt * 6);
    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((ring) => ring.age < 1.5);
    this.historyTime += dt;
    if (this.historyTime >= 1 / 30) {
      this.historyTime %= 1 / 30;
      this.history.unshift({
        wave: this.wave.slice(),
        bands: this.bands.slice(),
        level: this.level,
      });
      if (this.history.length > 48) this.history.pop();
    }
  }
}

const tau = Math.PI * 2;
const ink = (n: number): Ink => Math.max(1, Math.ceil(clamp(n) * 5)) as Ink;
const sample = (wave: Float32Array, x: number) =>
  wave[Math.min(wave.length - 1, Math.max(0, Math.floor(x * (wave.length - 1))))] ?? 0;

export function renderPersona(
  m: PersonaMotion,
  variant: PersonaVariant,
  columns: number,
  rows: number,
): Raster {
  const r = new Raster(columns, rows);
  const [idle = 0, listening = 0, thinking = 0, speaking = 0, asleep = 0] = m.weights;
  const awake = 1 - asleep;
  const t = m.time;
  const breathing = Math.sin(t * 1.5) * 0.035 * awake;
  const rest = 0.13 * idle + 0.2 * listening + 0.48 * thinking + 0.16 * speaking + 0.025 * asleep;
  const energy = clamp(rest + m.level * 0.68 + breathing + m.pulse * 0.09, 0.015, 0.98);
  const motion = m.phase;
  const wave = (u: number) => sample(m.wave, u) * m.level;
  const band = (i: number) => m.bands[i % 16] ?? 0;
  const shade = (n: number) => ink(n * (0.35 + 0.65 * awake));
  const trace = (fn: (u: number) => number, color: Ink = shade(1)) =>
    r.curve((u) => [u * (r.width - 1), (0.5 - fn(u) * 0.46) * (r.height - 1)], color);
  const orbit = (fn: (a: number) => readonly [number, number], color: Ink = shade(1)) => {
    const radius = Math.min(r.width - 1, r.height - 1) * 0.46;
    r.curve(
      (u) => {
        const [x, y] = fn(u * tau);
        return [(r.width - 1) / 2 + x * radius, (r.height - 1) / 2 + y * radius];
      },
      color,
      Math.min(900, Math.max(100, r.width * 4)),
    );
  };

  // A strip is a projection with its own sampling, not a cropped radial plot.
  if (rows <= 2) {
    const kind = variants.findIndex((v) => v.id === variant);
    for (let layer = rows === 1 ? 0 : 2; layer >= 0; layer--)
      trace(
        (u) => {
          const envelope = variant === "radial" ? Math.sin(Math.PI * u) ** 2 : 1;
          const carrier = Math.sin((u * tau * (kind + 2)) / 2 + motion - layer * 0.18);
          return (carrier * energy * 0.75 + wave(u) * 0.2) * envelope;
        },
        shade(1 - layer * 0.25),
      );
    return r;
  }

  switch (variant) {
    case "phosphor": {
      for (let age = 4; age >= 0; age--) {
        const history = m.history[Math.min(m.history.length - 1, age * 2)];
        trace(
          (u) => {
            const signal = history ? sample(history.wave, u) * history.level : wave(u);
            return (
              signal * 0.78 + Math.sin(u * tau * (2 + thinking * 2) - motion - age * 0.07) * rest
            );
          },
          shade(1 - age * 0.18),
        );
      }
      break;
    }
    case "waterfall": {
      const count = Math.min(20, Math.max(3, Math.floor(r.height / 3)));
      for (let depth = count - 1; depth >= 0; depth--) {
        const history = m.history[Math.min(m.history.length - 1, depth * 2)];
        const level = history?.level ?? m.level;
        const z = depth / count;
        r.curve(
          (u) => {
            const signal = sample(history?.wave ?? m.wave, u) * level;
            const ridge =
              (signal * 0.5 + Math.sin(u * tau * 3 - motion + z * 2) * rest) *
              Math.sin(u * Math.PI);
            return [
              (u * (0.86 - z * 0.12) + z * 0.12) * (r.width - 1),
              (0.86 - z * 0.64 - ridge * 0.23) * (r.height - 1),
            ];
          },
          shade(1 - z * 0.8),
        );
      }
      break;
    }
    case "braid": {
      const strands = columns < 18 ? 3 : 5;
      for (let strand = 0; strand < strands; strand++)
        trace(
          (u) =>
            Math.sin(
              u * tau * (1.8 + thinking) - motion + (strand * tau) / strands + wave(u) * 0.35,
            ) *
            (rest + band(strand * 3) * 0.58) *
            Math.sin(Math.PI * u),
          shade((strand + 1) / strands),
        );
      break;
    }
    case "fm": {
      for (let layer = 3; layer >= 0; layer--)
        trace(
          (u) =>
            Math.sin(
              u * tau * (2 + m.centroid * 5) +
                (1 + energy * 3) * Math.sin(u * tau - motion) +
                layer * (0.04 + m.level * 0.12),
            ) *
            energy *
            (0.6 + 0.4 * Math.sin(Math.PI * u)),
          shade(1 - layer * 0.2),
        );
      break;
    }
    case "rose": {
      for (let layer = 2; layer >= 0; layer--)
        orbit(
          (a) => {
            const petals = 3 + thinking * 4 + listening * 2 + speaking;
            const radius =
              (0.48 + energy * 0.4) *
              (0.64 + 0.34 * Math.cos(a * petals + motion + layer * 0.12)) *
              (0.25 + awake * 0.75);
            const flutter = band(Math.floor((a / tau) * 16)) * 0.07;
            return [
              Math.cos(a + motion * 0.12) * (radius + flutter),
              Math.sin(a + motion * 0.12) * (radius + flutter),
            ];
          },
          shade(1 - layer * 0.3),
        );
      break;
    }
    case "radial": {
      const core = 0.12 + energy * 0.3;
      orbit((a) => [Math.cos(a) * core, Math.sin(a) * core]);
      for (let ring = 0; ring < 3; ring++) {
        const radius = (0.24 + ring * 0.22 + Math.sin(motion - ring) * 0.025) * (0.3 + awake * 0.7);
        orbit(
          (a) => {
            const scale =
              radius + Math.sin(a * (4 + thinking * 3) - motion) * (0.02 + energy * 0.065);
            return [Math.cos(a) * scale, Math.sin(a) * scale];
          },
          shade(0.35 + energy * 0.45),
        );
      }
      for (const ring of m.rings) {
        const radius = 0.12 + (ring.age / 1.5) * 0.86;
        orbit(
          (a) => [Math.cos(a) * radius, Math.sin(a) * radius],
          shade((1 - ring.age / 1.5) * ring.strength),
        );
      }
      break;
    }
    case "standing": {
      for (let layer = 3; layer >= 0; layer--)
        trace(
          (u) =>
            Math.sin(u * tau * 2) *
              Math.cos(motion - layer * 0.12) *
              (rest + m.level * 0.3 + band(2) * 0.25) +
            Math.sin(u * tau * 4) * Math.sin(motion * 0.7 + layer * 0.08) * band(7) * 0.35,
          shade(1 - layer * 0.23),
        );
      break;
    }
    case "lissajous": {
      for (let layer = 3; layer >= 0; layer--)
        orbit(
          (a) => {
            const phase = motion * 0.35 - layer * 0.045;
            const radius = 0.15 + energy * 0.78;
            return [
              Math.sin(a * 3 + phase + wave(a / tau) * 0.3) * radius,
              Math.sin(a * 2 + phase * 0.4 + m.centroid * 0.8) * radius,
            ];
          },
          shade(1 - layer * 0.24),
        );
      break;
    }
  }
  return r;
}
