import { fg, StyledText, type TextChunk } from "@opentui/core";
import type { SignalFieldFrame, SignalFieldTone } from "./signal-field.ts";

export interface SignalFieldColors {
  faint: string;
  dim: string;
  you: string;
  agent: string;
  contact: string;
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

/** Coalesce adjacent cells with one tone to keep OpenTUI chunk counts bounded. */
export function styledSignalField(frame: SignalFieldFrame, colors: SignalFieldColors): StyledText {
  const chunks: TextChunk[] = [];
  frame.rows.forEach((row, rowIndex) => {
    let tone: SignalFieldTone | undefined;
    let text = "";
    const flush = (): void => {
      if (tone === undefined || text.length === 0) return;
      chunks.push(fg(colors[tone])(text));
      text = "";
    };
    for (const cell of row) {
      if (cell.tone !== tone) {
        flush();
        tone = cell.tone;
      }
      text += cell.char;
    }
    flush();
    if (rowIndex < frame.rows.length - 1) chunks.push(fg(colors.faint)("\n"));
  });
  return new StyledText(chunks);
}
