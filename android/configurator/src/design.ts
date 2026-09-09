export const muteChoices = ["rockers", "keycaps"] as const;
export type Design = {
  layout: "studio";
  header: "none";
  mute: (typeof muteChoices)[number];
  hold: "trigger";
  controlsHeightDp: number;
  holdSharePercent: number;
};
export type LegacyDesign = {
  layout: "original" | "studio";
  header: "quiet" | "drawer" | "none";
  mute: "glyphs" | "rockers" | "keycaps";
  hold: "beam" | "trigger" | "keycap";
};
export const defaultDesign: Design = {
  layout: "studio",
  header: "none",
  mute: "keycaps",
  hold: "trigger",
  controlsHeightDp: 262,
  // Retain the exact 130 + 16 + 116 dp layout, including the fixed join.
  holdSharePercent: (116 / 262) * 100,
};
export function equalDesign(a: Design, b: Design) {
  return (
    a.layout === b.layout &&
    a.header === b.header &&
    a.mute === b.mute &&
    a.hold === b.hold &&
    a.controlsHeightDp === b.controlsHeightDp &&
    Math.abs(a.holdSharePercent - b.holdSharePercent) < 1e-9
  );
}
export function parseDesign(value: unknown): Design {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 6 ||
    data["layout"] !== "studio" ||
    data["header"] !== "none" ||
    data["hold"] !== "trigger" ||
    !muteChoices.includes(data["mute"] as Design["mute"]) ||
    !Number.isInteger(data["controlsHeightDp"]) ||
    typeof data["controlsHeightDp"] !== "number" ||
    data["controlsHeightDp"] < 240 ||
    data["controlsHeightDp"] > 480 ||
    typeof data["holdSharePercent"] !== "number" ||
    !Number.isFinite(data["holdSharePercent"]) ||
    data["holdSharePercent"] < 30 ||
    data["holdSharePercent"] > 60
  )
    throw Error("Invalid design");
  return {
    layout: "studio",
    header: "none",
    mute: data["mute"] as Design["mute"],
    hold: "trigger",
    controlsHeightDp: data["controlsHeightDp"],
    holdSharePercent: data["holdSharePercent"],
  };
}
export function parseLegacyDesign(value: unknown): LegacyDesign {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid legacy design");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    !["original", "studio"].includes(data["layout"] as string) ||
    !["quiet", "drawer", "none"].includes(data["header"] as string) ||
    !["glyphs", "rockers", "keycaps"].includes(data["mute"] as string) ||
    !["beam", "trigger", "keycap"].includes(data["hold"] as string)
  )
    throw Error("Invalid legacy design");
  return data as LegacyDesign;
}
export function currentDesign(legacy?: LegacyDesign): Design {
  return { ...defaultDesign, mute: legacy?.mute === "rockers" ? "rockers" : "keycaps" };
}
