/**
 * Pure two-envelope text-mode animation shared by the Console and Remote
 * console. It renders energy, persistence, and turn overlap — never frequency.
 *
 * Two layers per cell: a glyph (the voice strands, or the graph-paper rules
 * where no strand reaches) and a wash (a background tint on a fine luminance
 * ramp). The floor is a continuously undulating calm that dims a touch while
 * anyone speaks; the strands lay over it. When both voices sound at once —
 * rare and brief in practice — their strands simply share the field, the
 * stronger one showing per cell: they touch, they never clash, and nothing
 * marks the overlap specially.
 */

export type SignalFieldChannel = "you" | "agent";
export type SignalFieldTone = "faint" | "dim" | "grid" | "you" | "agent";

/** Quantization of the wash ramp; steps are ~1 RGB unit apart, so seams stay invisible. */
export const WASH_STEPS = 14;

export interface SignalFieldCell {
  char: string;
  tone: SignalFieldTone;
  /** Background ramp step, 1..WASH_STEPS; absent renders the bare field base. */
  wash?: number;
}

export interface SignalFieldFrame {
  rows: SignalFieldCell[][];
  you: number;
  agent: number;
  contact: number;
  dominant: SignalFieldChannel | "contact" | "idle";
}

export const STANDBY_VARIANTS = ["swell", "pond", "weave"] as const;
export type StandbyVariant = (typeof STANDBY_VARIANTS)[number];

export interface SignalFieldOptions {
  seed?: number;
  attack?: number;
  release?: number;
  standby?: StandbyVariant;
}

interface VoiceState {
  energy: number;
  previousInput: number;
  onset: number;
  phase: number;
}

const YOU_GLYPHS = ["·", "╴", "─", "━", "┅", "┉"] as const;
const AGENT_GLYPHS = ["·", "╶", "─", "━", "┄", "┈"] as const;
const MUTED_GLYPHS = ["·", "┄", "┈"] as const;

/** ~Square paper at the usual 1:2 terminal cell aspect. */
const GRID_COLUMNS = 6;
const GRID_ROWS = 3;

export const GRID_GLYPHS = {
  cross: "┼",
  vertical: "│",
  horizontal: "─",
  origin: "╋",
  axisVertical: "┃",
  axisHorizontal: "━",
  axisVerticalCross: "╂",
  axisHorizontalCross: "┿",
} as const;

/**
 * Graph-paper rules with heavy center axes — a plotting surface, anchored at
 * field center so the paper stays symmetric under the voices.
 */
export function gridGlyph(x: number, y: number, width: number, height: number): string | undefined {
  const centerX = Math.floor((width - 1) / 2);
  const centerY = Math.floor((height - 1) / 2);
  const onColumn = (x - centerX) % GRID_COLUMNS === 0;
  const onRow = (y - centerY) % GRID_ROWS === 0;
  if (x === centerX && y === centerY) return GRID_GLYPHS.origin;
  if (x === centerX) return onRow ? GRID_GLYPHS.axisVerticalCross : GRID_GLYPHS.axisVertical;
  if (y === centerY) return onColumn ? GRID_GLYPHS.axisHorizontalCross : GRID_GLYPHS.axisHorizontal;
  if (onColumn && onRow) return GRID_GLYPHS.cross;
  if (onColumn) return GRID_GLYPHS.vertical;
  if (onRow) return GRID_GLYPHS.horizontal;
  return undefined;
}

export class SignalField {
  standby: StandbyVariant;

  private readonly seed: number;
  private readonly attack: number;
  private readonly release: number;
  private elapsed = 0;
  private frame = 0;
  private you: VoiceState = { energy: 0, previousInput: 0, onset: 0, phase: 0.7 };
  private agent: VoiceState = { energy: 0, previousInput: 0, onset: 0, phase: 2.4 };

  constructor(options: SignalFieldOptions = {}) {
    this.seed = Math.floor(options.seed ?? 0x51a1_0f1e);
    this.attack = options.attack ?? 13;
    this.release = options.release ?? 3.2;
    this.standby = options.standby ?? "swell";
  }

  step(
    deltaSeconds: number,
    input: { you: number; agent: number; youMuted?: boolean; agentMuted?: boolean },
  ): void {
    const dt = Math.max(0, Math.min(0.2, deltaSeconds));
    this.elapsed += dt;
    this.frame += 1;
    this.updateVoice(this.you, input.youMuted ? 0 : input.you, dt, 2.7);
    this.updateVoice(this.agent, input.agentMuted ? 0 : input.agent, dt, 2.05);
  }

  render(
    width: number,
    height: number,
    muted: { you?: boolean; agent?: boolean } = {},
  ): SignalFieldFrame {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const contact = Math.min(this.you.energy, this.agent.energy) * 1.35;
    const dominant: SignalFieldFrame["dominant"] =
      contact > 0.2
        ? "contact"
        : this.you.energy > this.agent.energy + 0.04
          ? "you"
          : this.agent.energy > this.you.energy + 0.04
            ? "agent"
            : this.you.energy + this.agent.energy < 0.05
              ? "idle"
              : "contact";
    const rows: SignalFieldCell[][] = [];

    for (let y = 0; y < h; y++) {
      const row: SignalFieldCell[] = [];
      for (let x = 0; x < w; x++) row.push(this.cell(x, y, w, h, muted));
      rows.push(row);
    }

    return { rows, you: this.you.energy, agent: this.agent.energy, contact, dominant };
  }

  private updateVoice(state: VoiceState, rawInput: number, dt: number, drift: number): void {
    const input = clamp01(rawInput);
    const rate = input > state.energy ? this.attack : this.release;
    state.energy += (input - state.energy) * (1 - Math.exp(-rate * dt));
    const rise = Math.max(0, input - state.previousInput);
    state.onset = Math.max(rise * 2.5, state.onset * Math.exp(-7 * dt));
    state.previousInput = input;
    state.phase += dt * (drift + state.energy * 7 + state.onset * 5);
  }

  private cell(
    x: number,
    y: number,
    width: number,
    height: number,
    muted: { you?: boolean; agent?: boolean },
  ): SignalFieldCell {
    const center = (width - 1) / 2;
    const half = Math.max(1, center);
    const nx = (x - center) / half;
    const ny = height === 1 ? 0 : (y / (height - 1)) * 2 - 1;
    const fromYou = (x + 0.5) / width;
    const fromAgent = (width - x - 0.5) / width;
    const hash = noise(x, y, this.frame, this.seed);
    const youTrack =
      Math.sin(x * 0.31 - this.you.phase) * (0.2 + this.you.energy * 0.14) +
      Math.sin(x * 0.11 + this.you.phase * 0.47) * 0.13;
    const agentTrack =
      Math.sin((width - x) * 0.27 - this.agent.phase) * (0.22 + this.agent.energy * 0.13) +
      Math.sin((width - x) * 0.09 + this.agent.phase * 0.51) * 0.12;
    const youDistance = strandDistance(ny, youTrack, hash);
    const agentDistance = strandDistance(ny, agentTrack, 1 - hash);
    const youReach = clamp01((this.you.energy * 0.92 + 0.1 - fromYou) / 0.18);
    const agentReach = clamp01((this.agent.energy * 0.92 + 0.1 - fromAgent) / 0.18);
    const traceWidth = 0.055 + 0.13 / Math.max(2, height);
    const youTrace = Math.exp(-(youDistance * youDistance) / traceWidth);
    const agentTrace = Math.exp(-(agentDistance * agentDistance) / traceWidth);
    const youStrength =
      this.you.energy * youReach * youTrace +
      this.you.onset * youReach * (hash > 0.72 ? 0.7 : 0.14) * Math.max(0, 1 - youDistance * 1.8);
    const agentStrength =
      this.agent.energy * agentReach * agentTrace +
      this.agent.onset *
        agentReach *
        (hash < 0.28 ? 0.7 : 0.14) *
        Math.max(0, 1 - agentDistance * 1.8);

    const wash = this.washAt(nx, ny);
    const threshold = 0.065;
    const strongest = Math.max(youStrength, agentStrength);
    if (strongest < threshold) {
      const paper = gridGlyph(x, y, width, height);
      if (paper !== undefined) return { char: paper, tone: "grid", wash };
      return { char: " ", tone: "faint", wash };
    }
    if (youStrength >= agentStrength) {
      return voiceCell(youStrength + hash * 0.08, "you", YOU_GLYPHS, muted.you === true, wash);
    }
    return voiceCell(
      agentStrength + hash * 0.08,
      "agent",
      AGENT_GLYPHS,
      muted.agent === true,
      wash,
    );
  }

  /** The undulating floor keeps flowing under the strands, a touch dimmer while anyone speaks. */
  private washAt(nx: number, ny: number): number | undefined {
    const activity = Math.max(this.you.energy, this.agent.energy);
    const calm = 1 - 0.45 * smoothstep(0.015, 0.11, activity);
    const level = clamp01(this.undulation(nx, ny) * calm);
    const step = Math.min(WASH_STEPS, Math.round(level * WASH_STEPS));
    return step < 1 ? undefined : step;
  }

  /** Continuous, slow, long-wavelength — adjacent cells sit on adjacent ramp steps. */
  private undulation(nx: number, ny: number): number {
    const t = this.elapsed;
    if (this.standby === "pond") {
      const r = Math.hypot(nx, ny * 0.8);
      return clamp01(0.42 + 0.34 * Math.sin(r * 2.3 - t * 0.44) * Math.exp(-r * 0.3));
    }
    if (this.standby === "weave") {
      return clamp01(
        0.45 + 0.26 * Math.sin(nx * 1.8 - t * 0.36) + 0.26 * Math.sin(ny * 1.9 + t * 0.28),
      );
    }
    return clamp01(
      0.45 +
        0.3 * Math.sin(nx * 2.1 + ny * 0.7 - t * 0.42) +
        0.17 * Math.sin(nx * 1.1 - ny * 0.5 + t * 0.31),
    );
  }
}

export function signalFieldText(frame: SignalFieldFrame): string {
  return frame.rows.map((row) => row.map((cell) => cell.char).join("")).join("\n");
}

const WASH_MIX = 0.26;

/** Wash step → concrete color: the field base lifted toward the faint tone. */
export function signalFieldWashColor(
  step: number,
  base: string,
  colors: { faint: string },
): string {
  const amount = (Math.min(WASH_STEPS, Math.max(1, step)) / WASH_STEPS) * WASH_MIX;
  return mixHex(base, colors.faint, amount);
}

export function mixHex(from: string, to: string, amount: number): string {
  const t = clamp01(amount);
  const a = parseHex(from);
  const b = parseHex(to);
  const channel = (index: 0 | 1 | 2): string =>
    Math.round(a[index] + (b[index] - a[index]) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function parseHex(color: string): [number, number, number] {
  const raw = color.startsWith("#") ? color.slice(1) : color;
  const value = Number.parseInt(raw, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function voiceCell(
  strength: number,
  tone: "you" | "agent",
  glyphs: readonly string[],
  muted: boolean,
  wash: number | undefined,
): SignalFieldCell {
  const value = clamp01(strength);
  const source = muted ? MUTED_GLYPHS : glyphs;
  const char = source[Math.min(source.length - 1, Math.floor(value * source.length))]!;
  return { char, tone: muted ? "dim" : tone, wash };
}

function strandDistance(y: number, track: number, variation: number): number {
  const core = Math.abs(y - track);
  const upper = Math.abs(y - (track * 0.42 - 0.5)) + 0.16 + variation * 0.09;
  const lower = Math.abs(y - (track * 0.42 + 0.5)) + 0.16 + (1 - variation) * 0.09;
  return Math.min(core, upper, lower);
}

function noise(x: number, y: number, frame: number, seed: number): number {
  let value = (x + 1) * 0x1f12_3bb5;
  value ^= (y + 1) * 0x0549_1333;
  value ^= (frame + 1) * 0x45d9_f3b;
  value ^= seed;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffff_ffff;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
