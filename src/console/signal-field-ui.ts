import { bg, bold, fg, StyledText, type TextChunk } from "@opentui/core";
import { formatClock } from "./dsp.ts";
import { type SignalFieldFrame, signalFieldWashColor } from "./signal-field.ts";
import { SIGNAL_GLYPHS, VOICE_TONES } from "./theme.ts";
import type { TransportPhase } from "./transport.ts";

const PHASE_LABEL: Record<TransportPhase, string> = {
  "waiting-ready": "WAITING FOR AGENT",
  negotiating: "NEGOTIATING VOICE",
  live: "LIVE",
  failed: "FAILED · R REDIAL",
  stopped: "STOPPED",
};

const COMPACT_PHASE_LABEL: Record<TransportPhase, string> = {
  "waiting-ready": "WAITING",
  negotiating: "NEGOTIATE",
  live: "LIVE",
  failed: "FAILED",
  stopped: "STOPPED",
};

const SIGNAL_MODE_SUFFIX = " / 48 KHZ";

export interface SignalFieldColors {
  faint: string;
  dim: string;
  you: string;
  agent: string;
  /** The color the field canvas sits on; washes are mixed up from it. */
  base?: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface SignalFieldStatus {
  text: string;
  color: string;
}

/** OpenTUI geometry may be transiently invalid while an over-constrained layout resizes. */
export function boundedViewportSize(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportSize {
  return {
    width: boundedViewportExtent(width, viewportWidth),
    height: boundedViewportExtent(height, viewportHeight),
  };
}

export function boundedViewportExtent(value: number, viewportExtent: number): number {
  const limit = Number.isFinite(viewportExtent) ? Math.max(1, Math.floor(viewportExtent)) : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(limit, Math.floor(value)));
}

export function signalFieldStatus(
  phase: TransportPhase,
  liveForMs: number | null,
  width: number,
  pulse: number,
): SignalFieldStatus {
  const busy = phase === "waiting-ready" || phase === "negotiating";
  const dotOn = !busy || Math.sin(pulse * 6) > 0;
  const color =
    phase === "live"
      ? VOICE_TONES.ok
      : phase === "failed"
        ? VOICE_TONES.err
        : busy
          ? VOICE_TONES.warn
          : VOICE_TONES.dim;
  const label = width < 64 ? COMPACT_PHASE_LABEL[phase] : PHASE_LABEL[phase];
  return {
    text: `${dotOn ? SIGNAL_GLYPHS.live : SIGNAL_GLYPHS.idle} ${label}${liveForMs === null ? "" : ` ${formatClock(liveForMs)}`}`,
    color,
  };
}

/** A piece of instrument text floated over the field at a fixed cell. */
export interface InstrumentTextRun {
  x: number;
  y: number;
  text: string;
  color: string;
  bold?: boolean;
}

export interface InstrumentVoice {
  muted: boolean;
  color: string;
  db: number;
}

/**
 * The push-to-talk box: a fixed 3-row interior (blank, label, blank) plus its
 * outlines — the voice boxes above take all remaining height. Shrinks only
 * when the terminal is too short for the full band.
 */
export function pttRowCount(height: number): number {
  return Math.max(1, Math.min(height - 4, 5));
}

/** A rounded box-drawing outline, one run per horizontal edge and per side cell. */
function outlineRuns(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
): InstrumentTextRun[] {
  if (x1 - x0 < 1 || y1 - y0 < 1) return [];
  const inner = "─".repeat(x1 - x0 - 1);
  const runs: InstrumentTextRun[] = [
    { x: x0, y: y0, text: `╭${inner}╮`, color },
    { x: x0, y: y1, text: `╰${inner}╯`, color },
  ];
  for (let y = y0 + 1; y < y1; y++) {
    runs.push({ x: x0, y, text: "│", color });
    runs.push({ x: x1, y, text: "│", color });
  }
  return runs;
}

/**
 * The whole instrument as floated text: status top-center, then the touch
 * zones drawn as inset outlines — mic and speaker side by side, each with
 * its label up top and readout down low, and push-to-talk across the bottom
 * band only while the mic is muted (`pttOpen`); otherwise the voice boxes
 * take the full height. The hit zones underneath tile the entire field; the
 * outlines only mark them.
 */
export function instrumentRuns(
  width: number,
  height: number,
  status: SignalFieldStatus,
  you: InstrumentVoice & { talking: boolean },
  agent: InstrumentVoice,
  pttOpen: boolean,
): InstrumentTextRun[] {
  const pttTop = height - (pttOpen ? pttRowCount(height) : 0);
  const center = Math.floor(width / 2);
  const leftCenter = Math.floor(width * 0.25);
  const rightCenter = Math.floor(width * 0.75);
  const centered = (text: string, at: number): number =>
    Math.max(0, at - Math.floor(text.length / 2));

  const runs: InstrumentTextRun[] = [];
  const withMode = width >= 44;
  const statusX = centered(withMode ? status.text + SIGNAL_MODE_SUFFIX : status.text, center);
  runs.push({ x: statusX, y: 0, text: status.text, color: status.color });
  if (withMode) {
    runs.push({
      x: statusX + status.text.length,
      y: 0,
      text: SIGNAL_MODE_SUFFIX,
      color: VOICE_TONES.dim,
    });
  }

  const boxTop = 1;
  const boxBottom = pttTop - 1;
  runs.push(...outlineRuns(0, boxTop, center - 1, boxBottom, VOICE_TONES.youDim));
  runs.push(...outlineRuns(center + 1, boxTop, width - 1, boxBottom, VOICE_TONES.agentDim));
  if (pttOpen) runs.push(...outlineRuns(0, pttTop, width - 1, height - 1, VOICE_TONES.faint));

  const labelRow = Math.max(boxTop, Math.min(boxTop + 1, boxBottom - 1));
  const dbRow = boxBottom - 1;
  const pttRow = Math.min(height - 1, pttTop + Math.floor((height - 1 - pttTop) / 2));
  const youLabel = `YOU ${you.talking ? `${SIGNAL_GLYPHS.live} TALKING` : you.muted ? "× PUSH" : "▷ INPUT"}`;
  const agentLabel = `AGENT ${agent.muted ? "× MUTED" : "◁ OUTPUT"}`;
  runs.push({
    x: centered(youLabel, leftCenter),
    y: labelRow,
    text: youLabel,
    color: you.color,
    bold: true,
  });
  runs.push({
    x: centered(agentLabel, rightCenter),
    y: labelRow,
    text: agentLabel,
    color: agent.color,
    bold: true,
  });

  if (dbRow > labelRow) {
    const youDb = dbText(you.db).trim();
    const agentDb = dbText(agent.db).trim();
    runs.push({ x: centered(youDb, leftCenter), y: dbRow, text: youDb, color: you.color });
    runs.push({ x: centered(agentDb, rightCenter), y: dbRow, text: agentDb, color: agent.color });
  }

  if (pttOpen) {
    const pttLabel = you.talking ? `${SIGNAL_GLYPHS.live} TALKING` : "PUSH TO TALK";
    runs.push({
      x: centered(pttLabel, center),
      y: pttRow,
      text: pttLabel,
      color: you.talking ? you.color : VOICE_TONES.dim,
      bold: true,
    });
  }
  return runs;
}

function dbText(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
}

export function styledSignalField(frame: SignalFieldFrame, colors: SignalFieldColors): StyledText {
  return styledInstrumentField(frame, colors, []);
}

interface OverlayCell {
  char: string;
  color: string;
  bold: boolean;
}

/**
 * The whole instrument on one canvas: the field runs edge to edge, with the
 * instrument text floated over it at each run's cell — the wash keeps
 * flowing under the text. A strand-free row suppresses voice strands while
 * the wash flows on — the status row is the one calm strip. Adjacent cells
 * sharing one (color, bold, wash) triple coalesce to keep OpenTUI chunk
 * counts bounded.
 */
export function styledInstrumentField(
  frame: SignalFieldFrame,
  colors: SignalFieldColors,
  runs: InstrumentTextRun[],
  strandFreeRows: readonly number[] = [],
): StyledText {
  const base = colors.base ?? VOICE_TONES.panel;
  const washCache = new Map<number, string>();
  const washColor = (step: number): string => {
    let color = washCache.get(step);
    if (color === undefined) {
      color = signalFieldWashColor(step, base, colors);
      washCache.set(step, color);
    }
    return color;
  };

  const height = frame.rows.length;
  const width = frame.rows[0]?.length ?? 0;
  const overlays = new Map<number, (OverlayCell | undefined)[]>();
  for (const run of runs) {
    if (run.y < 0 || run.y >= height) continue;
    let cells = overlays.get(run.y);
    if (cells === undefined) {
      cells = new Array(width);
      overlays.set(run.y, cells);
    }
    const chars = [...run.text];
    for (let i = 0; i < chars.length; i++) {
      const x = run.x + i;
      if (x < 0 || x >= width) continue;
      cells[x] = { char: chars[i]!, color: run.color, bold: run.bold === true };
    }
  }

  const chunks: TextChunk[] = [];
  frame.rows.forEach((row, rowIndex) => {
    const overlay = overlays.get(rowIndex);
    const strandFree = strandFreeRows.includes(rowIndex);
    let color: string | undefined;
    let boldText = false;
    let wash: number | undefined;
    let text = "";
    const flush = (): void => {
      if (color === undefined || text.length === 0) return;
      const styled = fg(color)(text);
      const weighted = boldText ? bold(styled) : styled;
      chunks.push(wash === undefined ? weighted : bg(washColor(wash))(weighted));
      text = "";
    };
    row.forEach((cell, x) => {
      const over = overlay?.[x];
      const muteStrand = strandFree && (cell.tone === "you" || cell.tone === "agent");
      const fieldTone = muteStrand ? "faint" : cell.tone;
      const fieldChar = muteStrand ? " " : cell.char;
      const cellColor = over === undefined ? colors[fieldTone] : over.color;
      const cellBold = over === undefined ? false : over.bold;
      if (cellColor !== color || cellBold !== boldText || cell.wash !== wash) {
        flush();
        color = cellColor;
        boldText = cellBold;
        wash = cell.wash;
      }
      text += over === undefined ? fieldChar : over.char;
    });
    flush();
    if (rowIndex < height - 1) chunks.push(fg(colors.faint)("\n"));
  });
  return new StyledText(chunks);
}
