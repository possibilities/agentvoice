/**
 * Signal Room tokens, as the archive console used them: structure stays
 * nearly monochrome, local amber and remote blue are confined to live signal.
 */
export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  localDim: "#806944",
  remote: "#7fb9e8",
  remoteDim: "#4d718b",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export const GLYPHS = {
  rail: "▎",
  live: "●",
  idle: "○",
  rule: "─",
  event: "·",
} as const;
