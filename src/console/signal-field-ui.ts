import { bg, fg, StyledText, type TextChunk } from "@opentui/core";
import {
  type SignalFieldFrame,
  type SignalFieldTone,
  signalFieldWashColor,
} from "./signal-field.ts";
import { VOICE_TONES } from "./theme.ts";

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
