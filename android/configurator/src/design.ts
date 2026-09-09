import { defaultSpacing, equalSpacing, parseSpacing, type Spacing } from "./spacing.ts";
import {
  defaultTraces,
  equalTraces,
  parseTraces,
  parseVersionNineTraces,
  type TraceSelection,
  type VersionNineTraceSelection,
} from "./traces.ts";

const legacyCompositions = ["open", "dock", "yoke", "socket", "traces"] as const;
export type VersionEightDesign = {
  layout: "studio";
  header: "none";
  mute: "rockers";
  hold: "rocker";
  composition: (typeof legacyCompositions)[number];
  controlsHeightDp: number;
  holdSharePercent: number;
};
export type VersionTenDesign = Omit<VersionEightDesign, "composition"> & {
  composition: "traces";
  traces: TraceSelection;
};
export type Design = VersionTenDesign & { spacing: Spacing };
export type VersionNineDesign = Omit<VersionEightDesign, "composition"> & {
  composition: "traces";
  traces: VersionNineTraceSelection;
};
export type VersionSevenDesign = Omit<VersionEightDesign, "mute" | "hold"> & {
  mute: "rockers" | "keycaps";
  hold: "trigger" | "rocker";
};
export type PreviousDesign = Omit<VersionSevenDesign, "hold" | "composition"> & { hold: "trigger" };
export type VersionSixDesign = Omit<VersionSevenDesign, "composition"> & {
  composition: "open" | "dock" | "yoke";
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
  mute: "rockers",
  hold: "rocker",
  composition: "traces",
  traces: defaultTraces(),
  spacing: defaultSpacing(),
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
    a.composition === b.composition &&
    a.controlsHeightDp === b.controlsHeightDp &&
    Math.abs(a.holdSharePercent - b.holdSharePercent) < 1e-9 &&
    equalTraces(a.traces, b.traces) &&
    equalSpacing(a.spacing, b.spacing)
  );
}
export function parseDesign(value: unknown): Design {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const { spacing, ...previous } = value as Record<string, unknown>;
  return { ...parseVersionTenDesign(previous), spacing: parseSpacing(spacing) };
}
export function parseVersionTenDesign(value: unknown): VersionTenDesign {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const { traces, ...previous } = value as Record<string, unknown>;
  const design = parseVersionEightDesign(previous);
  if (design.composition !== "traces") throw Error("Invalid composition");
  return { ...design, composition: "traces", traces: parseTraces(traces) };
}
export function parseVersionEightDesign(value: unknown): VersionEightDesign {
  const design = parseVersionSevenDesign(value);
  if (design.mute !== "rockers" || design.hold !== "rocker") throw Error("Invalid design");
  return { ...design, mute: "rockers", hold: "rocker" };
}
export function parseVersionNineDesign(value: unknown): VersionNineDesign {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const { traces, ...previous } = value as Record<string, unknown>;
  const design = parseVersionEightDesign(previous);
  if (design.composition !== "traces") throw Error("Invalid composition");
  return { ...design, composition: "traces", traces: parseVersionNineTraces(traces) };
}
export function parseVersionSevenDesign(value: unknown): VersionSevenDesign {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 7 ||
    data["layout"] !== "studio" ||
    data["header"] !== "none" ||
    !["trigger", "rocker"].includes(data["hold"] as string) ||
    !legacyCompositions.includes(data["composition"] as VersionEightDesign["composition"]) ||
    !["rockers", "keycaps"].includes(data["mute"] as string) ||
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
    mute: data["mute"] as VersionSevenDesign["mute"],
    hold: data["hold"] as VersionSevenDesign["hold"],
    composition: data["composition"] as VersionEightDesign["composition"],
    controlsHeightDp: data["controlsHeightDp"],
    holdSharePercent: data["holdSharePercent"],
  };
}
export function parsePreviousDesign(value: unknown): PreviousDesign {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid design");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 6 || "composition" in data || data["hold"] !== "trigger")
    throw Error("Invalid previous design");
  parseVersionSevenDesign({ ...data, composition: "open" });
  return data as PreviousDesign;
}
export function parseVersionSixDesign(value: unknown): VersionSixDesign {
  const design = parseVersionSevenDesign(value);
  if (
    design.composition !== "open" &&
    design.composition !== "dock" &&
    design.composition !== "yoke"
  )
    throw Error("Invalid version 6 composition");
  return { ...design, composition: design.composition };
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
