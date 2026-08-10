/**
 * Signal Room: the shared arthack instrument-panel palette.
 *
 * Structural colors stay nearly monochrome. Cool phosphor belongs to app
 * chrome; local amber and remote blue are confined to live signal surfaces.
 */
export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  remote: "#7fb9e8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export const VOICE_TONES = {
  bg: SIGNAL_ROOM.canvas,
  field: SIGNAL_ROOM.field,
  panel: SIGNAL_ROOM.panel,
  border: SIGNAL_ROOM.line,
  text: SIGNAL_ROOM.text,
  dim: SIGNAL_ROOM.muted,
  faint: SIGNAL_ROOM.faint,
  accent: SIGNAL_ROOM.accent,
  you: SIGNAL_ROOM.local,
  youDim: "#806944",
  agent: SIGNAL_ROOM.remote,
  agentDim: "#4d718b",
  ok: SIGNAL_ROOM.ok,
  warn: SIGNAL_ROOM.local,
  err: SIGNAL_ROOM.danger,
} as const;

export const SIGNAL_GLYPHS = {
  rail: "▎",
  live: "●",
  idle: "○",
  rule: "─",
  event: "·",
} as const;
