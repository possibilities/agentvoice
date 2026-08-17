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

const SIGNAL_MODE = "DUPLEX / 48 KHZ";

export interface SignalFieldColors {
  faint: string;
  dim: string;
  /** The graph-paper rules under the strands. */
  grid: string;
  /** The paper's center axes — ink a step brighter than the minor rules. */
  axis: string;
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

/** A piece of instrument text floated over the field at a fixed column. */
export interface InstrumentTextRun {
  x: number;
  text: string;
  color: string;
  bold?: boolean;
}

/** The rows floated over the field: labels on the top row, readout on the bottom. */
export interface InstrumentOverlays {
  top: InstrumentTextRun[];
  bottom: InstrumentTextRun[];
}

export function signalLabelRuns(
  width: number,
  youMuted: boolean,
  youTalking: boolean,
  agentMuted: boolean,
  youColor: string,
  agentColor: string,
): InstrumentTextRun[] {
  const left = `YOU ${youTalking ? `${SIGNAL_GLYPHS.live} TALKING` : youMuted ? "× MUTED" : "▷ INPUT"}`;
  const right = `${agentMuted ? "MUTED ×" : "OUTPUT ◁"} AGENT`;
  const clippedLeft = left.slice(0, Math.max(0, width - 1));
  const clippedRight = right.slice(
    Math.max(0, right.length - Math.max(0, width - clippedLeft.length - 1)),
  );
  const runs: InstrumentTextRun[] = [
    { x: 0, text: clippedLeft, color: youColor, bold: true },
    { x: width - clippedRight.length, text: clippedRight, color: agentColor, bold: true },
  ];
  const spare = width - clippedLeft.length - clippedRight.length;
  if (spare >= SIGNAL_MODE.length + 4) {
    runs.push({
      x: Math.max(clippedLeft.length + 1, Math.floor((width - SIGNAL_MODE.length) / 2)),
      text: SIGNAL_MODE,
      color: VOICE_TONES.dim,
    });
  }
  return runs;
}

export function signalReadoutRuns(
  width: number,
  youDb: number,
  agentDb: number,
  youColor: string,
  agentColor: string,
  status: SignalFieldStatus,
): InstrumentTextRun[] {
  const left = dbText(youDb);
  const right = dbText(agentDb);
  const runs: InstrumentTextRun[] = [
    { x: 0, text: left, color: youColor },
    { x: width - right.length, text: right, color: agentColor },
  ];
  const spare = width - left.length - right.length;
  if (spare >= status.text.length + 4) {
    runs.push({
      x: Math.max(left.length + 1, Math.floor((width - status.text.length) / 2)),
      text: status.text,
      color: status.color,
    });
  }
  return runs;
}

function dbText(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
}

export function styledSignalField(frame: SignalFieldFrame, colors: SignalFieldColors): StyledText {
  return styledInstrumentField(frame, colors, { top: [], bottom: [] });
}

interface OverlayCell {
  char: string;
  color: string;
  bold: boolean;
}

function overlayCells(runs: InstrumentTextRun[], width: number): (OverlayCell | undefined)[] {
  const cells: (OverlayCell | undefined)[] = new Array(width);
  for (const run of runs) {
    const chars = [...run.text];
    for (let i = 0; i < chars.length; i++) {
      const x = run.x + i;
      if (x < 0 || x >= width) continue;
      cells[x] = { char: chars[i]!, color: run.color, bold: run.bold === true };
    }
  }
  return cells;
}

/**
 * The whole instrument on one canvas: the field runs edge to edge, with the
 * label and readout rows floated over its top and bottom rows — the wash
 * keeps flowing under the text. Adjacent cells sharing one (color, bold,
 * wash) triple coalesce to keep OpenTUI chunk counts bounded.
 */
export function styledInstrumentField(
  frame: SignalFieldFrame,
  colors: SignalFieldColors,
  overlays: InstrumentOverlays,
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
  const top = overlayCells(overlays.top, width);
  const bottom = overlayCells(overlays.bottom, width);
  const overlayFor = (rowIndex: number): (OverlayCell | undefined)[] | undefined => {
    if (rowIndex === 0 && rowIndex === height - 1) {
      return top.map((cell, x) => bottom[x] ?? cell);
    }
    if (rowIndex === 0) return top;
    if (rowIndex === height - 1) return bottom;
    return undefined;
  };

  const chunks: TextChunk[] = [];
  frame.rows.forEach((row, rowIndex) => {
    const overlay = overlayFor(rowIndex);
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
      const cellColor = over === undefined ? colors[cell.tone] : over.color;
      const cellBold = over === undefined ? false : over.bold;
      if (cellColor !== color || cellBold !== boldText || cell.wash !== wash) {
        flush();
        color = cellColor;
        boldText = cellBold;
        wash = cell.wash;
      }
      text += over === undefined ? cell.char : over.char;
    });
    flush();
    if (rowIndex < height - 1) chunks.push(fg(colors.faint)("\n"));
  });
  return new StyledText(chunks);
}
