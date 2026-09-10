export const tracePatterns = ["parallel", "splayed", "circuit"] as const;
const versionNineAmountFields = [
  "stancePercent",
  "weightPercent",
  "offshootPercent",
  "glowPercent",
] as const;
const versionThirteenAmountFields = [
  "stancePercent",
  "personaSpacingPercent",
  "footSpacingPercent",
  "weightPercent",
  "offshootPercent",
  "glowPercent",
] as const;
export const traceTipFields = ["reachDp", "fadeLengthDp", "tipOpacityPercent"] as const;
const versionSixteenAmountFields = [...versionThirteenAmountFields, ...traceTipFields] as const;
export const traceAmountFields = [
  "stancePercent",
  "personaSpacingPercent",
  "footSpacingPercent",
  "weightPercent",
  "glowPercent",
  ...traceTipFields,
] as const;
export type VersionNineTraceSelection = {
  pattern: (typeof tracePatterns)[number];
  stancePercent: number;
  weightPercent: number;
  offshootPercent: number;
  glowPercent: number;
};
export type VersionThirteenTraceSelection = VersionNineTraceSelection & {
  personaSpacingPercent: number;
  footSpacingPercent: number;
};
export type VersionSixteenTraceSelection = VersionThirteenTraceSelection &
  Record<(typeof traceTipFields)[number], number>;
export type TraceSelection = Omit<VersionSixteenTraceSelection, "offshootPercent">;
const versionNineBounds = {
  stancePercent: [75, 150],
  weightPercent: [50, 250],
  offshootPercent: [0, 100],
  glowPercent: [0, 100],
} as const;
export const traceBounds = {
  stancePercent: versionNineBounds.stancePercent,
  weightPercent: versionNineBounds.weightPercent,
  glowPercent: versionNineBounds.glowPercent,
  reachDp: [-40, 120],
  fadeLengthDp: [0, 80],
  tipOpacityPercent: [0, 100],
  personaSpacingPercent: [50, 200],
  footSpacingPercent: [50, 200],
} as const;

export function defaultTraces(): TraceSelection {
  return {
    pattern: "parallel",
    stancePercent: 100,
    personaSpacingPercent: 100,
    footSpacingPercent: 100,
    weightPercent: 100,
    glowPercent: 0,
    reachDp: 0,
    fadeLengthDp: 12,
    tipOpacityPercent: 0,
  };
}

export function parseTraces(value: unknown): TraceSelection {
  return parseTraceFields(value, traceAmountFields) as TraceSelection;
}

export function parseVersionSixteenTraces(value: unknown): VersionSixteenTraceSelection {
  return parseTraceFields(value, versionSixteenAmountFields) as VersionSixteenTraceSelection;
}

export function migrateTraces(value: Partial<VersionSixteenTraceSelection>): TraceSelection {
  const { offshootPercent: _, ...current } = value;
  return { ...defaultTraces(), ...current };
}

export function parseVersionThirteenTraces(value: unknown): VersionThirteenTraceSelection {
  return parseTraceFields(value, versionThirteenAmountFields) as VersionThirteenTraceSelection;
}

export function parseVersionNineTraces(value: unknown): VersionNineTraceSelection {
  return parseTraceFields(value, versionNineAmountFields) as VersionNineTraceSelection;
}

function parseTraceFields(
  value: unknown,
  fields: readonly (typeof versionSixteenAmountFields)[number][],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid traces");
  const data = value as Record<string, unknown>;
  const keys = ["pattern", ...fields];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !(key in data)) ||
    !tracePatterns.includes(data["pattern"] as TraceSelection["pattern"])
  )
    throw Error("Invalid traces");
  for (const field of fields) {
    const value = data[field];
    const [min, max] =
      field === "offshootPercent" ? versionNineBounds.offshootPercent : traceBounds[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      throw Error("Invalid traces");
  }
  return { ...data };
}

export function equalTraces(a: TraceSelection, b: TraceSelection) {
  return a.pattern === b.pattern && traceAmountFields.every((field) => a[field] === b[field]);
}
