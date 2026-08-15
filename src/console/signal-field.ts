/**
 * Pure two-envelope text-mode animation shared by the Client and Remote
 * console. It renders energy, persistence, and turn overlap — never frequency.
 */

export type SignalFieldChannel = "you" | "agent";
export type SignalFieldTone = "faint" | "dim" | "you" | "agent" | "contact";

export interface SignalFieldCell {
  char: string;
  tone: SignalFieldTone;
}

export interface SignalFieldFrame {
  rows: SignalFieldCell[][];
  you: number;
  agent: number;
  contact: number;
  dominant: SignalFieldChannel | "contact" | "idle";
}

export interface SignalFieldOptions {
  seed?: number;
  attack?: number;
  release?: number;
}

interface VoiceState {
  energy: number;
  previousInput: number;
  onset: number;
  phase: number;
}

const YOU_GLYPHS = ["·", "╴", "─", "━", "┅", "┉"] as const;
const AGENT_GLYPHS = ["·", "╶", "─", "━", "┄", "┈"] as const;
const CONTACT_GLYPHS = ["╳", "┼", "┿", "╬", "※", "#"] as const;
const MUTED_GLYPHS = ["·", "┄", "┈"] as const;

export class SignalField {
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
      for (let x = 0; x < w; x++) row.push(this.cell(x, y, w, h, contact, muted));
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
    contact: number,
    muted: { you?: boolean; agent?: boolean },
  ): SignalFieldCell {
    const center = (width - 1) / 2;
    const half = Math.max(1, center);
    const nx = (x - center) / half;
    const ny = height === 1 ? 0 : (y / (height - 1)) * 2 - 1;
    const fromYou = (x + 0.5) / width;
    const fromAgent = (width - x - 0.5) / width;
    const hash = noise(x, y, this.frame, this.seed);
    const activity = Math.max(this.you.energy, this.agent.energy);
    const idlePresence = 1 - smoothstep(0.015, 0.11, activity);
    const idleCell = this.idleCell(x, y, width, height, idlePresence);
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
    const faultWidth = 0.035 + contact * 0.29;
    const fault = Math.max(
      0,
      1 - Math.abs(nx + Math.sin(y * 1.8 + this.elapsed * 4) * contact * 0.1) / faultWidth,
    );
    const interference =
      contact * fault * (0.65 + 0.35 * Math.sin(y * 3.1 + x * 0.7 + this.elapsed * 11));
    const scars =
      contact > 0.04 && hash > 0.94 - contact * 0.12 ? contact * (0.25 + hash * 0.7) : 0;

    if (interference + scars > 0.34) {
      const intensity = clamp01(interference + scars + Math.max(youStrength, agentStrength) * 0.25);
      return {
        char: CONTACT_GLYPHS[
          Math.min(CONTACT_GLYPHS.length - 1, Math.floor(intensity * CONTACT_GLYPHS.length))
        ]!,
        tone: "contact",
      };
    }

    const strongest = Math.max(youStrength, agentStrength);
    if (strongest < 0.065) return idleCell ?? { char: " ", tone: "faint" };
    if (youStrength >= agentStrength) {
      return voiceCell(youStrength + hash * 0.08, "you", YOU_GLYPHS, muted.you === true);
    }
    if (agentStrength >= 0.065) {
      return voiceCell(agentStrength + hash * 0.08, "agent", AGENT_GLYPHS, muted.agent === true);
    }
    return idleCell ?? { char: " ", tone: "faint" };
  }

  private idleCell(
    x: number,
    y: number,
    width: number,
    height: number,
    presence: number,
  ): SignalFieldCell | null {
    if (presence < 0.04) return null;

    const nx = width === 1 ? 0 : (x / (width - 1)) * 2 - 1;
    const ny = height === 1 ? 0 : (y / (height - 1)) * 2 - 1;
    const rowHeight = height === 1 ? 2 : 2 / (height - 1);
    const grooveCount = idleGrooveCount(height);
    const extent = grooveCount === 1 ? 0 : grooveCount === 2 ? 0.38 : 0.72;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestGroove = 0;

    for (let groove = 0; groove < grooveCount; groove++) {
      const position = grooveCount === 1 ? 0 : groove / (grooveCount - 1);
      let track = -extent + position * extent * 2;
      track += Math.sin(this.elapsed * 0.17 + groove * 1.41) * 0.018;
      track += Math.sin(nx * 1.15 + this.elapsed * 0.11 + groove * 0.23) * 0.012;
      track = bendAroundStone(track, nx, -0.43, -0.16, 0.32, 0.19, groove % 2 === 0 ? -1 : 1);
      track = bendAroundStone(track, nx, 0.46, 0.24, 0.25, 0.15, groove % 2 === 0 ? 1 : -1);

      const distance = Math.abs(ny - track);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestGroove = groove;
      }
    }

    if (nearestDistance > rowHeight * 0.46) return null;

    const stable = noise(x, nearestGroove, 0, this.seed ^ 0x72a4_3d19);
    if (presence < 0.28 + stable * 0.68) return null;
    const broken = noise(x >> 1, nearestGroove, 0, this.seed ^ 0x1d1e_5eed);
    if (broken > 0.93) return stable > 0.72 ? { char: "·", tone: "faint" } : null;

    const sweep = positiveModulo(this.elapsed + 3.5, 22) / 22;
    const rakeHead = -1.2 + sweep * 2.4;
    const behind = rakeHead - nx;
    const head = Math.exp(-((nx - rakeHead) ** 2) / 0.012);
    const wake = behind >= 0 && behind < 0.62 ? Math.exp(-behind * 4.8) : 0;
    const rake = Math.max(head, wake * 0.72) * presence;

    if (head * presence > 0.42) {
      return { char: stable > 0.77 ? "╴" : "─", tone: "dim" };
    }
    if (rake > 0.24) return { char: "┄", tone: rake > 0.43 ? "dim" : "faint" };
    return { char: stable > 0.86 ? "╴" : "┈", tone: "faint" };
  }
}

export function signalFieldText(frame: SignalFieldFrame): string {
  return frame.rows.map((row) => row.map((cell) => cell.char).join("")).join("\n");
}

function voiceCell(
  strength: number,
  tone: "you" | "agent",
  glyphs: readonly string[],
  muted: boolean,
): SignalFieldCell {
  const value = clamp01(strength);
  const source = muted ? MUTED_GLYPHS : glyphs;
  const char = source[Math.min(source.length - 1, Math.floor(value * source.length))]!;
  return { char, tone: muted ? "dim" : tone };
}

function strandDistance(y: number, track: number, variation: number): number {
  const core = Math.abs(y - track);
  const upper = Math.abs(y - (track * 0.42 - 0.5)) + 0.16 + variation * 0.09;
  const lower = Math.abs(y - (track * 0.42 + 0.5)) + 0.16 + (1 - variation) * 0.09;
  return Math.min(core, upper, lower);
}

function idleGrooveCount(height: number): number {
  if (height <= 2) return 1;
  if (height <= 4) return 2;
  return Math.min(5, Math.max(3, Math.round(height / 2.5)));
}

function bendAroundStone(
  track: number,
  x: number,
  stoneX: number,
  stoneY: number,
  radius: number,
  lift: number,
  tieDirection: -1 | 1,
): number {
  const dx = (x - stoneX) / radius;
  const dy = track - stoneY;
  const influence = Math.exp(-dx * dx * 1.7) * Math.exp(-((dy / 0.48) ** 2));
  const direction = Math.abs(dy) < 0.025 ? tieDirection : Math.sign(dy);
  return track + direction * lift * influence;
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

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
