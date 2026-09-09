import { equalHalo, type HaloSelection, parseHalo } from "./halo.ts";
import type { Layout, Preview } from "./protocol.ts";
import { equalSpirit, parseSpirit, type SpiritSelection } from "./spirit.ts";
import { equalTraces, parseTraces, type TraceSelection } from "./traces.ts";

export const appearanceGroups = ["glow", "halo", "spirit", "traces"] as const;
export type AppearanceGroup = (typeof appearanceGroups)[number];
export type SharedAppearance = {
  traces: Omit<TraceSelection, "glowPercent">;
  glowPercent: number;
  halo: Omit<HaloSelection, "containedSizePercent">;
  spirit: SpiritSelection;
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid appearance");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some((key) => !(key in data)))
    throw Error("Invalid appearance fields");
  return data;
}
export function parseAppearanceOverrides(value: unknown): AppearanceGroup[] {
  if (
    !Array.isArray(value) ||
    value.length > appearanceGroups.length ||
    value.some(
      (group, index) =>
        !appearanceGroups.includes(group) || (index > 0 && value[index - 1] >= group),
    )
  )
    throw Error("Invalid appearance overrides");
  return [...value];
}
export function parseSharedAppearance(value: unknown): SharedAppearance {
  const data = object(value, ["traces", "glowPercent", "halo", "spirit"]);
  const traces = data["traces"];
  if (!traces || typeof traces !== "object" || Array.isArray(traces) || "glowPercent" in traces)
    throw Error("Invalid shared traces");
  const halo = data["halo"];
  if (!halo || typeof halo !== "object" || Array.isArray(halo) || "containedSizePercent" in halo)
    throw Error("Invalid shared Halo");
  const glowPercent = data["glowPercent"];
  if (
    typeof glowPercent !== "number" ||
    !Number.isInteger(glowPercent) ||
    glowPercent < 0 ||
    glowPercent > 100
  )
    throw Error("Invalid shared glow");
  const { glowPercent: _, ...parsedTraces } = parseTraces({ ...traces, glowPercent: 0 });
  const { containedSizePercent: _size, ...parsedHalo } = parseHalo({
    ...halo,
    containedSizePercent: 78,
  });
  return {
    traces: parsedTraces,
    glowPercent,
    halo: parsedHalo,
    spirit: parseSpirit(data["spirit"]),
  };
}
export function appearanceOf(layout: Pick<Layout, "design" | "halo" | "spirit">): SharedAppearance {
  const { glowPercent, ...traces } = layout.design.traces;
  const { containedSizePercent: _, ...halo } = layout.halo;
  return structuredClone({ traces, glowPercent, halo, spirit: layout.spirit });
}
export function equalAppearanceGroup(
  a: SharedAppearance,
  b: SharedAppearance,
  group: AppearanceGroup,
): boolean {
  switch (group) {
    case "glow":
      return a.glowPercent === b.glowPercent;
    case "traces":
      return equalTraces({ ...a.traces, glowPercent: 0 }, { ...b.traces, glowPercent: 0 });
    case "halo":
      return equalHalo(
        { ...a.halo, containedSizePercent: 78 },
        { ...b.halo, containedSizePercent: 78 },
      );
    case "spirit":
      return equalSpirit(a.spirit, b.spirit);
  }
}
export function equalSharedAppearance(a: SharedAppearance, b: SharedAppearance): boolean {
  return appearanceGroups.every((group) => equalAppearanceGroup(a, b, group));
}
export function applyAppearanceGroup<T extends Layout>(
  layout: T,
  shared: SharedAppearance,
  group: AppearanceGroup,
): T {
  const next = structuredClone(layout);
  switch (group) {
    case "glow":
      next.design.traces.glowPercent = shared.glowPercent;
      break;
    case "traces":
      next.design.traces = { ...shared.traces, glowPercent: next.design.traces.glowPercent };
      break;
    case "halo":
      next.halo = {
        ...structuredClone(shared.halo),
        containedSizePercent: next.halo.containedSizePercent,
      };
      break;
    case "spirit":
      next.spirit = { ...shared.spirit };
      break;
  }
  return next;
}
export function applySharedAppearance<T extends Layout>(layout: T, shared: SharedAppearance): T {
  let next = structuredClone(layout);
  for (const group of appearanceGroups)
    if (!next.appearanceOverrides.includes(group)) next = applyAppearanceGroup(next, shared, group);
  return next;
}
export function mergeAppearanceEdit(
  previous: Preview,
  requested: Preview,
  shared: SharedAppearance,
  other: Layout,
) {
  const nextShared = structuredClone(shared);
  let nextRequested = structuredClone(requested);
  const previousAppearance = appearanceOf(previous);
  for (const group of appearanceGroups) {
    if (
      requested.appearanceOverrides.includes(group) &&
      !previous.appearanceOverrides.includes(group)
    )
      nextRequested = applyAppearanceGroup(nextRequested, previousAppearance, group);
  }
  const requestedAppearance = appearanceOf(requested);
  for (const group of appearanceGroups) {
    if (
      requested.appearanceOverrides.includes(group) ||
      previous.appearanceOverrides.includes(group)
    )
      continue;
    switch (group) {
      case "glow":
        nextShared.glowPercent = requestedAppearance.glowPercent;
        break;
      case "traces":
        nextShared.traces = requestedAppearance.traces;
        break;
      case "halo":
        nextShared.halo = requestedAppearance.halo;
        break;
      case "spirit":
        nextShared.spirit = requestedAppearance.spirit;
        break;
    }
  }
  return {
    preview: applySharedAppearance(nextRequested, nextShared),
    sharedAppearance: nextShared,
    otherLayout: applySharedAppearance(other, nextShared),
  };
}
