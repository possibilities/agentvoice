export const haloColorStates = ["speaking", "listening", "idle"] as const;
export type HaloColors = Record<(typeof haloColorStates)[number], string>;
export const haloMotionFields = [
  "ringSpreadPercent",
  "listeningPulsePercent",
  "speakingMotionPercent",
  "idleBreathingPercent",
] as const;
export const thinkingWingspanBounds = { min: 1, max: 10, default: 2 } as const;
export type HaloSelection = {
  variant: "original" | "contained";
  containedSizePercent: number;
  thinkingWingspan: number;
  colors: HaloColors;
} & Record<(typeof haloMotionFields)[number], number>;

export function defaultHalo(): HaloSelection {
  return {
    variant: "original",
    containedSizePercent: 78,
    thinkingWingspan: thinkingWingspanBounds.default,
    ringSpreadPercent: 35,
    listeningPulsePercent: 25,
    speakingMotionPercent: 25,
    idleBreathingPercent: 25,
    colors: { speaking: "#bbaaff", listening: "#d4ff72", idle: "#f0f2e9" },
  };
}

export function parseHalo(value: unknown): HaloSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Halo");
  const data = value as Record<string, unknown>;
  const keys = [
    "variant",
    "containedSizePercent",
    "thinkingWingspan",
    "colors",
    ...haloMotionFields,
  ];
  if (Object.keys(data).length !== keys.length || keys.some((key) => !(key in data)))
    throw Error("Invalid Halo fields");
  if (data["variant"] !== "original" && data["variant"] !== "contained")
    throw Error("Invalid Halo variant");
  const percent = (key: string, min: number, max: number): number => {
    const number = data[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max)
      throw Error("Invalid Halo percentage");
    return number;
  };
  const colorData = data["colors"];
  if (!colorData || typeof colorData !== "object" || Array.isArray(colorData))
    throw Error("Invalid Halo colors");
  const colors = colorData as Record<string, unknown>;
  if (Object.keys(colors).length !== 3) throw Error("Invalid Halo colors");
  const color = (key: string): string => {
    const value = colors[key];
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
      throw Error("Invalid Halo color");
    return value.toLowerCase();
  };
  return {
    variant: data["variant"],
    containedSizePercent: percent("containedSizePercent", 35, 120),
    thinkingWingspan: percent(
      "thinkingWingspan",
      thinkingWingspanBounds.min,
      thinkingWingspanBounds.max,
    ),
    ringSpreadPercent: percent("ringSpreadPercent", 0, 100),
    listeningPulsePercent: percent("listeningPulsePercent", 0, 100),
    speakingMotionPercent: percent("speakingMotionPercent", 0, 100),
    idleBreathingPercent: percent("idleBreathingPercent", 0, 100),
    colors: { speaking: color("speaking"), listening: color("listening"), idle: color("idle") },
  };
}

/** Add fields introduced after the persisted legacy profile/state shape in memory only. */
export function migrateLegacyHaloFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) migrateLegacyHaloFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if ("variant" in data && "colors" in data && "ringSpreadPercent" in data) {
    if ("thinkingWingspan" in data) throw Error("Legacy Halo contains current fields");
    data["thinkingWingspan"] = thinkingWingspanBounds.default;
  }
  for (const item of Object.values(data)) migrateLegacyHaloFields(item);
}

export function equalHalo(a: HaloSelection, b: HaloSelection) {
  return (
    a.variant === b.variant &&
    a.containedSizePercent === b.containedSizePercent &&
    a.thinkingWingspan === b.thinkingWingspan &&
    haloMotionFields.every((key) => a[key] === b[key]) &&
    haloColorStates.every((key) => a.colors[key] === b.colors[key])
  );
}
