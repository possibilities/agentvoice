import {
  currentDesign,
  type Design,
  type LegacyDesign,
  type PreviousDesign,
  parseDesign,
  parseLegacyDesign,
  parsePreviousDesign,
  parseVersionSixDesign,
  type VersionSixDesign,
} from "./design.ts";
import { defaultHalo, type HaloSelection, parseHalo } from "./halo.ts";

import { defaultSpirit, parseSpirit, type SpiritSelection } from "./spirit.ts";

export const activities = ["steady", "voice"] as const;
export type Activity = (typeof activities)[number];
export const modes = ["speaking", "listening", "idle"] as const;
export type Mode = (typeof modes)[number];
export type Scales = Record<Mode, number>;
export const connections = ["connected", "connecting", "disconnected"] as const;
export type Connection = (typeof connections)[number];
export type Preview = {
  connection: Connection;
  activity: Activity;
  mode: Mode;
  scales: Scales;
  verticalOffsetDp: number;
  design: Design;
  halo: HaloSelection;
  spirit: SpiritSelection;
};
export type PhoneState = Preview & {
  protocol: 7;
  revision: number;
  holding: boolean;
  savedScales: Scales;
  defaults: Scales;
  savedVerticalOffsetDp: number;
  defaultVerticalOffsetDp: number;
  savedDesign: Design;
  defaultDesign: Design;
  savedHalo: HaloSelection;
  defaultHalo: HaloSelection;
  savedSpirit: SpiritSelection;
  defaultSpirit: SpiritSelection;
  micMuted: boolean;
  speakerMuted: boolean;
};
export type Profile = {
  scaleMultipliers: Scales;
  verticalOffsetDp: number;
  connectedArtboardScale: 1.9;
  disconnectedArtboardScale: 1.5;
  savedAtEpochMs: number;
} & (
  | { version: 2; design?: never }
  | { version: 3; design: LegacyDesign }
  | { version: 4; design: PreviousDesign }
  | { version: 5; design: PreviousDesign; halo: HaloSelection }
  | { version: 6; design: VersionSixDesign; halo: HaloSelection }
  | { version: 7; design: Design; halo: HaloSelection; spirit: SpiritSelection }
);

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
  exact(data, [
    "connection",
    "activity",
    "mode",
    "scales",
    "verticalOffsetDp",
    "design",
    "halo",
    "spirit",
  ]);
  if (!connections.includes(data["connection"] as Connection))
    throw Error("Invalid connection preview");
  if (!activities.includes(data["activity"] as Activity)) throw Error("Invalid preview activity");
  return {
    connection: data["connection"] as Connection,
    activity: data["activity"] as Activity,
    mode: mode(data["mode"]),
    scales: parseScales(data["scales"]),
    verticalOffsetDp: integer(data["verticalOffsetDp"], -200, 200),
    design: parseDesign(data["design"]),
    halo: parseHalo(data["halo"]),
    spirit: parseSpirit(data["spirit"]),
  };
}

export function parseState(value: unknown): PhoneState {
  const data = record(value);
  exact(data, [
    "protocol",
    "connection",
    "activity",
    "revision",
    "holding",
    "mode",
    "scales",
    "savedScales",
    "defaults",
    "verticalOffsetDp",
    "savedVerticalOffsetDp",
    "defaultVerticalOffsetDp",
    "design",
    "savedDesign",
    "defaultDesign",
    "halo",
    "savedHalo",
    "defaultHalo",
    "spirit",
    "savedSpirit",
    "defaultSpirit",
    "micMuted",
    "speakerMuted",
  ]);
  if (
    data["protocol"] !== 7 ||
    !connections.includes(data["connection"] as Connection) ||
    !activities.includes(data["activity"] as Activity) ||
    typeof data["holding"] !== "boolean" ||
    typeof data["micMuted"] !== "boolean" ||
    typeof data["speakerMuted"] !== "boolean"
  )
    throw Error("Invalid phone state");
  return {
    protocol: 7,
    connection: data["connection"] as Connection,
    activity: data["activity"] as Activity,
    revision: integer(data["revision"]),
    holding: data["holding"],
    mode: mode(data["mode"]),
    scales: parseScales(data["scales"]),
    savedScales: parseScales(data["savedScales"]),
    defaults: parseScales(data["defaults"]),
    verticalOffsetDp: integer(data["verticalOffsetDp"], -200, 200),
    savedVerticalOffsetDp: integer(data["savedVerticalOffsetDp"], -200, 200),
    defaultVerticalOffsetDp: integer(data["defaultVerticalOffsetDp"], -200, 200),
    design: parseDesign(data["design"]),
    halo: parseHalo(data["halo"]),
    spirit: parseSpirit(data["spirit"]),
    savedDesign: parseDesign(data["savedDesign"]),
    defaultDesign: parseDesign(data["defaultDesign"]),
    savedHalo: parseHalo(data["savedHalo"]),
    defaultHalo: parseHalo(data["defaultHalo"]),
    savedSpirit: parseSpirit(data["savedSpirit"]),
    defaultSpirit: parseSpirit(data["defaultSpirit"]),
    micMuted: data["micMuted"],
    speakerMuted: data["speakerMuted"],
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
    ...([3, 4, 5, 6, 7].includes(data["version"] as number) ? ["design"] : []),
    ...([5, 6, 7].includes(data["version"] as number) ? ["halo"] : []),
    ...(data["version"] === 7 ? ["spirit"] : []),
  ]);
  if (
    ![2, 3, 4, 5, 6, 7].includes(data["version"] as number) ||
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
  integer(data["verticalOffsetDp"], -200, 200);
  integer(data["savedAtEpochMs"], 1);
  if (data["version"] === 3) parseLegacyDesign(data["design"]);
  if (data["version"] === 4 || data["version"] === 5) parsePreviousDesign(data["design"]);
  if (data["version"] === 6) parseVersionSixDesign(data["design"]);
  if (data["version"] === 7) {
    parseDesign(data["design"]);
    parseSpirit(data["spirit"]);
  }
  if (data["version"] === 5 || data["version"] === 6 || data["version"] === 7)
    data["halo"] = parseHalo(data["halo"]);
  return data as Profile;
}

export function profileDesign(profile: Profile): Design {
  if (profile.version === 6 || profile.version === 7) return profile.design;
  if (profile.version === 4 || profile.version === 5)
    return { ...profile.design, composition: "open" };
  return currentDesign(profile.design);
}

export function profileHalo(profile: Profile): HaloSelection {
  return profile.version === 5 || profile.version === 6 || profile.version === 7
    ? profile.halo
    : defaultHalo();
}

export function profileSpirit(profile: Profile): SpiritSelection {
  return profile.version === 7 ? profile.spirit : defaultSpirit();
}

export function previewOf(state: Preview): Preview {
  return {
    connection: state.connection,
    activity: state.activity,
    mode: state.mode,
    scales: { ...state.scales },
    verticalOffsetDp: state.verticalOffsetDp,
    design: { ...state.design },
    halo: structuredClone(state.halo),
    spirit: { ...state.spirit },
  };
}

export function equalScales(a: Scales, b: Scales): boolean {
  return modes.every((mode) => a[mode] === b[mode]);
}

export interface Phone {
  state: PhoneState;
  connected: boolean;
  disconnectReason?: string;
  reconnecting?: boolean;
  generation?: number;
  request(command: Record<string, unknown>): Promise<{ state: PhoneState; profile?: string }>;
}
