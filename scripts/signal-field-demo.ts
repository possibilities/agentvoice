#!/usr/bin/env bun
/**
 * Signal-field lab: drives the real SignalField with scripted speech
 * envelopes and paints frames as raw truecolor ANSI — the same frame data
 * the consoles render, without codex, audio, or OpenTUI. For design passes:
 * flip scenes, standby variants, and viewport sizes live and compare.
 */
import {
  SignalField,
  type SignalFieldTone,
  STANDBY_VARIANTS,
  signalFieldWashColor,
} from "../src/console/signal-field.ts";
import { SIGNAL_ROOM, VOICE_TONES } from "../src/console/theme.ts";

const LOOP = 12;
const FPS = 30;

const SIZES = ["full", "remote", "tiny"] as const;

interface Scenario {
  name: string;
  envelope(t: number): { you: number; agent: number };
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic speech-like envelope: utterance runs with syllabic flutter. */
function makeSpeech(seed: number, dense = false): (t: number) => number {
  const rng = mulberry32(seed);
  const segments: Array<{ start: number; end: number; pitch: number }> = [];
  let at = rng() * 0.3;
  while (at < LOOP - 0.2) {
    const length = dense ? 0.9 + rng() * 1.6 : 0.35 + rng() * 1.1;
    const end = Math.min(LOOP - 0.05, at + length);
    segments.push({ start: at, end, pitch: 2.8 + rng() * 2.4 });
    at = end + (dense ? 0.1 + rng() * 0.25 : rng() < 0.25 ? 0.7 + rng() * 0.9 : 0.12 + rng() * 0.4);
  }
  return (raw: number) => {
    const t = positiveModulo(raw, LOOP);
    let level = 0;
    for (const segment of segments) {
      const attack = smoothstep(segment.start - 0.05, segment.start + 0.07, t);
      const decay = 1 - smoothstep(segment.end - 0.03, segment.end + 0.09, t);
      const gate = attack * decay;
      if (gate <= 0) continue;
      const syllable = 0.74 + 0.26 * Math.sin(t * Math.PI * 2 * segment.pitch + segment.start * 9);
      level = Math.max(level, gate * syllable);
    }
    return clamp01(level);
  };
}

function window(t: number, from: number, to: number, rise = 0.5): number {
  return smoothstep(from, from + rise, t) * (1 - smoothstep(to - rise, to, t));
}

const soloYou = makeSpeech(101);
const soloAgent = makeSpeech(202);
const denseYou = makeSpeech(303, true);
const denseAgent = makeSpeech(404, true);

const SCENARIOS: Scenario[] = [
  { name: "standby", envelope: () => ({ you: 0, agent: 0 }) },
  { name: "you", envelope: (t) => ({ you: soloYou(t), agent: 0 }) },
  { name: "agent", envelope: (t) => ({ you: 0, agent: soloAgent(t) }) },
  {
    name: "handoff",
    envelope: (t) => {
      const tt = positiveModulo(t, LOOP);
      return { you: soloYou(t) * window(tt, 0, 5.4), agent: soloAgent(t) * window(tt, 4.3, 11.2) };
    },
  },
  {
    name: "interject",
    envelope: (t) => {
      const tt = positiveModulo(t, LOOP);
      return {
        you: denseYou(t) * window(tt, 4.6, 5.8),
        agent: denseAgent(t) * window(tt, 0.3, 11.6),
      };
    },
  },
];

function parseHex(color: string): [number, number, number] {
  const raw = color.startsWith("#") ? color.slice(1) : color;
  const value = Number.parseInt(raw, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function fgSgr(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgSgr(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface LabState {
  scenario: number;
  size: (typeof SIZES)[number];
  paused: boolean;
  t: number;
}

const state: LabState = { scenario: 0, size: "full", paused: false, t: 0 };
const field = new SignalField({ seed: 0x2e6d_07e });

function fieldSize(cols: number, rows: number): { width: number; height: number } {
  const maxWidth = Math.max(8, cols - 4);
  const maxHeight = Math.max(1, rows - 8);
  if (state.size === "remote") {
    return { width: Math.min(34, maxWidth), height: Math.min(7, maxHeight) };
  }
  if (state.size === "tiny") {
    return { width: Math.min(24, maxWidth), height: Math.min(3, maxHeight) };
  }
  return { width: maxWidth, height: maxHeight };
}

function meterBar(level: number, hex: string, width: number): string {
  const filled = Math.round(clamp01(level) * width);
  return (
    fgSgr(hex) +
    "█".repeat(filled) +
    fgSgr(VOICE_TONES.faint) +
    "─".repeat(Math.max(0, width - filled)) +
    RESET
  );
}

function paint(): void {
  const cols = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 28;
  const scenario = SCENARIOS[state.scenario % SCENARIOS.length]!;
  const { width, height } = fieldSize(cols, rows);
  const margin = Math.max(0, Math.floor((cols - width) / 2));
  const pad = " ".repeat(margin);

  const tones: Record<SignalFieldTone, string> = {
    faint: VOICE_TONES.faint,
    dim: VOICE_TONES.dim,
    you: VOICE_TONES.you,
    agent: VOICE_TONES.agent,
  };
  const washCache = new Map<number, string>();
  const washBg = (step: number): string => {
    let sgr = washCache.get(step);
    if (sgr === undefined) {
      sgr = bgSgr(signalFieldWashColor(step, VOICE_TONES.panel, { faint: VOICE_TONES.faint }));
      washCache.set(step, sgr);
    }
    return sgr;
  };

  const env = scenario.envelope(state.t);
  const frame = field.render(width, height);

  const lines: string[] = [];
  lines.push(
    `${BOLD}${fgSgr(SIGNAL_ROOM.accent)}▎ SIGNAL FIELD LAB${RESET}  ` +
      `${fgSgr(VOICE_TONES.text)}scene:${scenario.name} ${(state.scenario % SCENARIOS.length) + 1}/${SCENARIOS.length}${RESET}  ` +
      `${fgSgr(VOICE_TONES.dim)}t=${state.t.toFixed(1)}s  ${width}×${height} (${state.size})${state.paused ? "  ⏸ paused" : ""}${RESET}`,
  );
  lines.push(`${fgSgr(VOICE_TONES.dim)}standby:${fgSgr(VOICE_TONES.text)}${field.standby}${RESET}`);
  lines.push("");

  const baseBg = bgSgr(VOICE_TONES.panel);
  for (const row of frame.rows) {
    let out = pad;
    let currentFg = "";
    let currentBg = "";
    for (const cell of row) {
      const cellFg = fgSgr(tones[cell.tone]);
      const cellBg = cell.wash === undefined ? baseBg : washBg(cell.wash);
      if (cellFg !== currentFg || cellBg !== currentBg) {
        out += cellBg + cellFg;
        currentFg = cellFg;
        currentBg = cellBg;
      }
      out += cell.char;
    }
    lines.push(out + RESET);
  }

  lines.push("");
  const barWidth = Math.max(6, Math.min(18, Math.floor((cols - 30) / 2)));
  lines.push(
    `${pad}${fgSgr(VOICE_TONES.you)}YOU${RESET} ${meterBar(env.you, VOICE_TONES.you, barWidth)} ` +
      `${fgSgr(VOICE_TONES.dim)}${env.you.toFixed(2)}${RESET}  ` +
      `${fgSgr(VOICE_TONES.agent)}AGENT${RESET} ${meterBar(env.agent, VOICE_TONES.agent, barWidth)} ` +
      `${fgSgr(VOICE_TONES.dim)}${env.agent.toFixed(2)}${RESET}`,
  );
  lines.push(
    `${fgSgr(VOICE_TONES.faint)}1-5 scene · s standby · [ ] size · space pause · r reset · q quit${RESET}`,
  );

  while (lines.length < rows - 1) lines.push("");
  process.stdout.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}`);
}

let lastTick = Date.now();
function tick(): void {
  const now = Date.now();
  const dt = Math.min(0.2, (now - lastTick) / 1000);
  lastTick = now;
  if (!state.paused) {
    state.t += dt;
    const scenario = SCENARIOS[state.scenario % SCENARIOS.length]!;
    field.step(dt, scenario.envelope(state.t));
  }
  paint();
}

function cycle<T>(list: readonly T[], current: T, step = 1): T {
  const index = list.indexOf(current);
  return list[(index + step + list.length) % list.length]!;
}

function shutdown(): void {
  clearInterval(timer);
  process.stdin.setRawMode?.(false);
  process.stdout.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

if (!process.stdout.isTTY) {
  console.error("signal-field lab needs a TTY (run it inside a terminal or tmux pane)");
  process.exit(1);
}

process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data: Buffer) => {
  for (const byte of data) {
    const key = String.fromCharCode(byte);
    if (key === "q" || byte === 0x03) shutdown();
    else if (key >= "1" && key <= "5") {
      state.scenario = Number(key) - 1;
      state.t = 0;
    } else if (key === "s") field.standby = cycle(STANDBY_VARIANTS, field.standby);
    else if (key === "]") state.size = cycle(SIZES, state.size);
    else if (key === "[") state.size = cycle(SIZES, state.size, -1);
    else if (key === " ") {
      state.paused = !state.paused;
      lastTick = Date.now();
    } else if (key === "r") state.t = 0;
  }
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("resize", () => process.stdout.write("\x1b[2J"));

const timer = setInterval(tick, 1000 / FPS);
