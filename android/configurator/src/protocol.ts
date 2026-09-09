import {
  type Design,
  defaultDesign,
  equalDesign,
  type LegacyDesign,
  type PreviousDesign,
  parseDesign,
  parseLegacyDesign,
  parsePreviousDesign,
  parseVersionEightDesign,
  parseVersionNineDesign,
  parseVersionSevenDesign,
  parseVersionSixDesign,
  parseVersionTenDesign,
  type VersionEightDesign,
  type VersionNineDesign,
  type VersionSevenDesign,
  type VersionSixDesign,
  type VersionTenDesign,
} from "./design.ts";
import { defaultHalo, equalHalo, type HaloSelection, parseHalo } from "./halo.ts";
import { type MutedTuning, parseMutedTuning } from "./muted-presence.ts";
import { defaultSpacing } from "./spacing.ts";
import { defaultSpirit, equalSpirit, parseSpirit, type SpiritSelection } from "./spirit.ts";
import { defaultTraces } from "./traces.ts";

export const themes = ["bright", "quiet", "grayscale"] as const;
export type Theme = (typeof themes)[number];
export const mutedPresences = ["tide", "off"] as const;
export type MutedPresence = (typeof mutedPresences)[number];
export const activities = ["steady", "voice"] as const;
export type Activity = (typeof activities)[number];
export const modes = ["speaking", "listening", "idle"] as const;
export type Mode = (typeof modes)[number];
export type Scales = Record<Mode, number>;
export const connections = ["connected", "connecting", "disconnected"] as const;
export type Connection = (typeof connections)[number];
export const orientations = ["portrait", "landscape"] as const;
export type Orientation = (typeof orientations)[number];
export type PersonaSide = "left" | "right";
export type OrientationFence = { orientation: Orientation; orientationEpoch: number };
export type Layout = {
  scales: Scales;
  verticalOffsetDp: number;
  design: Design;
  halo: HaloSelection;
  spirit: SpiritSelection;
  personaSide: PersonaSide;
};
export type VersionElevenLayout = Omit<Layout, "design"> & { design: VersionTenDesign };
export type Preview = Layout &
  OrientationFence & {
    theme: Theme;
    mutedPresence: MutedPresence;
    mutedTuning: MutedTuning;
    connection: Connection;
    activity: Activity;
    mode: Mode;
  };
export type PhoneState = Preview & {
  protocol: 13;
  otherLayout: Layout;
  savedOtherLayout: Layout;
  savedPersonaSide: PersonaSide;
  defaultPersonaSide: PersonaSide;
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
  | { version: 7; design: VersionSevenDesign; halo: HaloSelection; spirit: SpiritSelection }
  | { version: 8; design: VersionEightDesign; halo: HaloSelection; spirit: SpiritSelection }
  | { version: 9; design: VersionNineDesign; halo: HaloSelection; spirit: SpiritSelection }
  | { version: 10; design: VersionTenDesign; halo: HaloSelection; spirit: SpiritSelection }
  | {
      version: 11;
      design: VersionTenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      landscape: VersionElevenLayout;
    }
  | {
      version: 12;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      landscape: Layout;
    }
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
    "orientation",
    "orientationEpoch",
    "personaSide",
    "theme",
    "mutedPresence",
    "mutedTuning",
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
    ...parseOrientationFence(data),
    personaSide: parsePersonaSide(data["personaSide"]),
    ...parseSessionModes(data),
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
    "otherLayout",
    "savedOtherLayout",
    "savedPersonaSide",
    "defaultPersonaSide",
    "orientation",
    "orientationEpoch",
    "personaSide",
    "theme",
    "mutedPresence",
    "mutedTuning",
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
    data["protocol"] !== 13 ||
    !connections.includes(data["connection"] as Connection) ||
    !activities.includes(data["activity"] as Activity) ||
    typeof data["holding"] !== "boolean" ||
    typeof data["micMuted"] !== "boolean" ||
    typeof data["speakerMuted"] !== "boolean"
  )
    throw Error("Invalid phone state");
  return {
    protocol: 13,
    otherLayout: parseLayout(data["otherLayout"]),
    savedOtherLayout: parseLayout(data["savedOtherLayout"]),
    savedPersonaSide: parsePersonaSide(data["savedPersonaSide"]),
    defaultPersonaSide: parsePersonaSide(data["defaultPersonaSide"]),
    ...parseOrientationFence(data),
    personaSide: parsePersonaSide(data["personaSide"]),
    ...parseSessionModes(data),
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
    ...([11, 12].includes(data["version"] as number) ? ["personaSide", "landscape"] : []),
    ...([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(data["version"] as number) ? ["design"] : []),
    ...([5, 6, 7, 8, 9, 10, 11, 12].includes(data["version"] as number) ? ["halo"] : []),
    ...([7, 8, 9, 10, 11, 12].includes(data["version"] as number) ? ["spirit"] : []),
  ]);
  if (
    ![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(data["version"] as number) ||
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
  if (data["version"] === 7) parseVersionSevenDesign(data["design"]);
  if (data["version"] === 8) parseVersionEightDesign(data["design"]);
  if (data["version"] === 9) parseVersionNineDesign(data["design"]);
  if (data["version"] === 10 || data["version"] === 11) parseVersionTenDesign(data["design"]);
  if (data["version"] === 12) parseDesign(data["design"]);
  if (data["version"] === 11 || data["version"] === 12) {
    parsePersonaSide(data["personaSide"]);
    if (data["version"] === 11) parseVersionElevenLayout(data["landscape"]);
    else data["landscape"] = parseLayout(data["landscape"]);
  }
  if ([7, 8, 9, 10, 11, 12].includes(data["version"] as number)) {
    parseSpirit(data["spirit"]);
  }
  if ([5, 6, 7, 8, 9, 10, 11, 12].includes(data["version"] as number))
    data["halo"] = parseHalo(data["halo"]);
  return data as Profile;
}

export function profileDesign(profile: Profile): Design {
  if (profile.version === 12) return structuredClone(profile.design);
  if (profile.version === 10 || profile.version === 11)
    return { ...structuredClone(profile.design), spacing: defaultSpacing() };
  if (profile.version === 9)
    return {
      ...profile.design,
      traces: { ...defaultTraces(), ...profile.design.traces },
      spacing: defaultSpacing(),
    };
  if (profile.version !== 2 && profile.version !== 3)
    return {
      ...profile.design,
      mute: "rockers",
      hold: "rocker",
      composition: "traces",
      traces: defaultTraces(),
      spacing: defaultSpacing(),
    };
  return structuredClone(defaultDesign);
}

export function profileHalo(profile: Profile): HaloSelection {
  return profile.version === 5 ||
    profile.version === 6 ||
    profile.version === 7 ||
    profile.version === 8 ||
    profile.version === 9 ||
    profile.version === 10 ||
    profile.version === 11 ||
    profile.version === 12
    ? profile.halo
    : defaultHalo();
}

export function profileSpirit(profile: Profile): SpiritSelection {
  return profile.version === 7 ||
    profile.version === 8 ||
    profile.version === 9 ||
    profile.version === 10 ||
    profile.version === 11 ||
    profile.version === 12
    ? profile.spirit
    : defaultSpirit();
}

export function previewOf(state: Preview): Preview {
  return {
    orientation: state.orientation,
    orientationEpoch: state.orientationEpoch,
    personaSide: state.personaSide,
    theme: state.theme,
    mutedPresence: state.mutedPresence,
    mutedTuning: { ...state.mutedTuning },
    connection: state.connection,
    activity: state.activity,
    mode: state.mode,
    scales: { ...state.scales },
    verticalOffsetDp: state.verticalOffsetDp,
    design: structuredClone(state.design),
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

export function parseOrientationFence(data: Record<string, unknown>): OrientationFence {
  if (!orientations.includes(data["orientation"] as Orientation))
    throw Error("Invalid orientation");
  return {
    orientation: data["orientation"] as Orientation,
    orientationEpoch: integer(data["orientationEpoch"]),
  };
}

export function sameOrientation(a: OrientationFence, b: OrientationFence): boolean {
  return a.orientation === b.orientation && a.orientationEpoch === b.orientationEpoch;
}

export function parsePersonaSide(value: unknown): PersonaSide {
  if (value !== "left" && value !== "right") throw Error("Invalid Persona side");
  return value;
}

export function parseLayout(value: unknown): Layout {
  const previous = parseVersionElevenLayoutFields(value);
  return { ...previous, design: parseDesign(previous.design) };
}
export function parseVersionElevenLayout(value: unknown): VersionElevenLayout {
  const previous = parseVersionElevenLayoutFields(value);
  return { ...previous, design: parseVersionTenDesign(previous.design) };
}
function parseVersionElevenLayoutFields(value: unknown) {
  const data = record(value);
  exact(data, ["scales", "verticalOffsetDp", "design", "halo", "spirit", "personaSide"]);
  return {
    scales: parseScales(data["scales"]),
    verticalOffsetDp: integer(data["verticalOffsetDp"], -200, 200),
    design: data["design"],
    halo: parseHalo(data["halo"]),
    spirit: parseSpirit(data["spirit"]),
    personaSide: parsePersonaSide(data["personaSide"]),
  };
}

export function layoutOf(value: Layout): Layout {
  return structuredClone({
    scales: value.scales,
    verticalOffsetDp: value.verticalOffsetDp,
    design: value.design,
    halo: value.halo,
    spirit: value.spirit,
    personaSide: value.personaSide,
  });
}

export function defaultLandscapeLayout(): Layout {
  return {
    scales: { speaking: 78, listening: 58, idle: 78 },
    verticalOffsetDp: 0,
    design: structuredClone(defaultDesign),
    halo: defaultHalo(),
    spirit: defaultSpirit(),
    personaSide: "left",
  };
}

export function profileLayout(profile: Profile, orientation: Orientation): Layout {
  if (orientation === "landscape") {
    if (profile.version === 12) return layoutOf(profile.landscape);
    if (profile.version === 11)
      return {
        ...structuredClone(profile.landscape),
        design: { ...structuredClone(profile.landscape.design), spacing: defaultSpacing() },
      };
    return defaultLandscapeLayout();
  }
  return {
    scales: {
      speaking: Math.round(profile.scaleMultipliers.speaking * 100),
      listening: Math.round(profile.scaleMultipliers.listening * 100),
      idle: Math.round(profile.scaleMultipliers.idle * 100),
    },
    verticalOffsetDp: profile.verticalOffsetDp,
    design: profileDesign(profile),
    halo: structuredClone(profileHalo(profile)),
    spirit: { ...profileSpirit(profile) },
    personaSide: profile.version === 11 || profile.version === 12 ? profile.personaSide : "left",
  };
}

export function equalLayout(a: Layout, b: Layout): boolean {
  return (
    equalScales(a.scales, b.scales) &&
    a.verticalOffsetDp === b.verticalOffsetDp &&
    equalDesign(a.design, b.design) &&
    equalHalo(a.halo, b.halo) &&
    equalSpirit(a.spirit, b.spirit) &&
    a.personaSide === b.personaSide
  );
}

export function parseSessionModes(data: Record<string, unknown>): {
  theme: Theme;
  mutedPresence: MutedPresence;
  mutedTuning: MutedTuning;
} {
  if (!themes.includes(data["theme"] as Theme)) throw Error("Invalid theme");
  if (!mutedPresences.includes(data["mutedPresence"] as MutedPresence))
    throw Error("Invalid muted presence");
  return {
    theme: data["theme"] as Theme,
    mutedPresence: data["mutedPresence"] as MutedPresence,
    mutedTuning: parseMutedTuning(data["mutedTuning"]),
  };
}

export function defaultPortraitLayout(): Layout {
  const layout = defaultLandscapeLayout();
  return {
    ...layout,
    scales: { speaking: 78, listening: 56, idle: 78 },
    verticalOffsetDp: -22,
    design: {
      ...layout.design,
      controlsHeightDp: 387,
      holdSharePercent: 40.9,
      traces: {
        ...layout.design.traces,
        stancePercent: 130,
        weightPercent: 175,
        offshootPercent: 88,
      },
    },
    halo: { ...layout.halo, variant: "contained" },
    spirit: { ...layout.spirit, persona: "follow" },
  };
}
