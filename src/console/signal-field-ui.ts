import { bg, bold, fg, StyledText, type TextChunk } from "@opentui/core";
import { formatClock } from "./dsp.ts";
import {
  type SignalFieldFrame,
  type SignalFieldTone,
  signalFieldWashColor,
} from "./signal-field.ts";
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

export function styledSignalLabels(
  width: number,
  youMuted: boolean,
  youTalking: boolean,
  agentMuted: boolean,
  youColor: string,
  agentColor: string,
): StyledText {
  const left = `YOU ${youTalking ? `${SIGNAL_GLYPHS.live} TALKING` : youMuted ? "× MUTED" : "▷ INPUT"}`;
  const right = `${agentMuted ? "MUTED ×" : "OUTPUT ◁"} AGENT`;
  const clippedRight = right.slice(
    Math.max(0, right.length - Math.max(0, width - left.length - 1)),
  );
  const clippedLeft = left.slice(0, Math.max(0, width - 1));
  const spare = Math.max(1, width - Math.min(left.length, width - 1) - clippedRight.length);
  const center = spare >= SIGNAL_MODE.length + 4 ? SIGNAL_MODE : "";
  if (center.length === 0) {
    return new StyledText([
      bold(fg(youColor)(clippedLeft)),
      fg(VOICE_TONES.faint)(" ".repeat(spare)),
      bold(fg(agentColor)(clippedRight)),
    ]);
  }
  const before = Math.max(1, Math.floor((width - center.length) / 2) - clippedLeft.length);
  const after = Math.max(1, spare - before - center.length);
  return new StyledText([
    bold(fg(youColor)(clippedLeft)),
    fg(VOICE_TONES.faint)(" ".repeat(before)),
    fg(VOICE_TONES.dim)(center),
    fg(VOICE_TONES.faint)(" ".repeat(after)),
    bold(fg(agentColor)(clippedRight)),
  ]);
}

export function styledSignalReadout(
  width: number,
  youDb: number,
  agentDb: number,
  youColor: string,
  agentColor: string,
  status: SignalFieldStatus,
): StyledText {
  const left = dbText(youDb);
  const right = dbText(agentDb);
  const spare = Math.max(1, width - left.length - right.length);
  const center = spare >= status.text.length + 4 ? status : undefined;
  if (center === undefined) {
    return new StyledText([
      fg(youColor)(left),
      fg(VOICE_TONES.faint)(" ".repeat(spare)),
      fg(agentColor)(right),
    ]);
  }
  const before = Math.max(1, Math.floor((width - center.text.length) / 2) - left.length);
  const after = Math.max(1, spare - before - center.text.length);
  return new StyledText([
    fg(youColor)(left),
    fg(VOICE_TONES.faint)(" ".repeat(before)),
    fg(center.color)(center.text),
    fg(VOICE_TONES.faint)(" ".repeat(after)),
    fg(agentColor)(right),
  ]);
}

function dbText(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
}

/** Coalesce adjacent cells with one (tone, wash) pair to keep OpenTUI chunk counts bounded. */
export function styledSignalField(frame: SignalFieldFrame, colors: SignalFieldColors): StyledText {
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

  const chunks: TextChunk[] = [];
  frame.rows.forEach((row, rowIndex) => {
    let tone: SignalFieldTone | undefined;
    let wash: number | undefined;
    let text = "";
    const flush = (): void => {
      if (tone === undefined || text.length === 0) return;
      const styled = fg(colors[tone])(text);
      chunks.push(wash === undefined ? styled : bg(washColor(wash))(styled));
      text = "";
    };
    for (const cell of row) {
      if (cell.tone !== tone || cell.wash !== wash) {
        flush();
        tone = cell.tone;
        wash = cell.wash;
      }
      text += cell.char;
    }
    flush();
    if (rowIndex < frame.rows.length - 1) chunks.push(fg(colors.faint)("\n"));
  });
  return new StyledText(chunks);
}
