export const modes = ["speaking", "listening", "idle"] as const;
export type Mode = (typeof modes)[number];
export type Scales = Record<Mode, number>;
export type Preview = { mode: Mode; scales: Scales };
export type PhoneState = Preview & {
  protocol: 1;
  revision: number;
  holding: boolean;
  savedScales: Scales;
  defaults: Scales;
};
export type Profile = {
  version: 2;
  scaleMultipliers: Scales;
  verticalOffsetDp: 35;
  connectedArtboardScale: 1.9;
  disconnectedArtboardScale: 1.5;
  savedAtEpochMs: number;
};

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected an object");
  return value as Record<string, unknown>;
}

export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw Error("Unexpected fields");
  }
}

export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw Error("Invalid integer");
  }
  return value;
}

export function parseScales(value: unknown): Scales {
  const data = record(value);
  exact(data, [...modes]);
  return {
    speaking: integer(data["speaking"], 35, 120),
    listening: integer(data["listening"], 35, 120),
    idle: integer(data["idle"], 35, 120),
  };
}

function mode(value: unknown): Mode {
  if (!modes.includes(value as Mode)) throw Error("Invalid preview state");
  return value as Mode;
}

export function parsePreview(value: unknown): Preview {
  const data = record(value);
  exact(data, ["mode", "scales"]);
  return { mode: mode(data["mode"]), scales: parseScales(data["scales"]) };
}

export function parseState(value: unknown): PhoneState {
  const data = record(value);
  exact(data, ["protocol", "revision", "holding", "mode", "scales", "savedScales", "defaults"]);
  if (data["protocol"] !== 1 || typeof data["holding"] !== "boolean")
    throw Error("Invalid phone state");
  return {
    protocol: 1,
    revision: integer(data["revision"]),
    holding: data["holding"],
    mode: mode(data["mode"]),
    scales: parseScales(data["scales"]),
    savedScales: parseScales(data["savedScales"]),
    defaults: parseScales(data["defaults"]),
  };
}

export function parseProfile(text: string): Profile {
  if (text.length > 4096) throw Error("Profile too large");
  const data = record(JSON.parse(text));
  exact(data, [
    "version",
    "scaleMultipliers",
    "verticalOffsetDp",
    "connectedArtboardScale",
    "disconnectedArtboardScale",
    "savedAtEpochMs",
  ]);
  if (
    data["version"] !== 2 ||
    data["verticalOffsetDp"] !== 35 ||
    data["connectedArtboardScale"] !== 1.9 ||
    data["disconnectedArtboardScale"] !== 1.5
  ) {
    throw Error("Unsupported profile");
  }
  const scales = record(data["scaleMultipliers"]);
  const percentages = Object.fromEntries(
    Object.entries(scales).map(([key, value]) => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw Error("Invalid scale");
      const percent = Math.round(value * 100);
      if (Math.abs(percent / 100 - value) > 1e-8) throw Error("Invalid scale precision");
      return [key, percent];
    }),
  );
  parseScales(percentages);
  integer(data["savedAtEpochMs"], 1);
  return data as Profile;
}

export function equalScales(a: Scales, b: Scales): boolean {
  return modes.every((mode) => a[mode] === b[mode]);
}

export interface Phone {
  state: PhoneState;
  connected: boolean;
  disconnectReason?: string;
  request(command: Record<string, unknown>): Promise<{ state: PhoneState; profile?: string }>;
}
