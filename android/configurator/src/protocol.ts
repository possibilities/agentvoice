import {
  type AppearanceGroup,
  appearanceGroups,
  appearanceOf,
  applySharedAppearance,
  equalAppearanceGroup,
  parseAppearanceOverrides,
  parseSharedAppearance,
  parseVersionSixteenSharedAppearance,
  type SharedAppearance,
  type VersionSixteenSharedAppearance,
} from "./appearance.ts";
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
  parseVersionSeventeenDesign,
  parseVersionSixDesign,
  parseVersionSixteenDesign,
  parseVersionTenDesign,
  parseVersionThirteenDesign,
  parseVersionTwelveDesign,
  type VersionEightDesign,
  type VersionNineDesign,
  type VersionSevenDesign,
  type VersionSeventeenDesign,
  type VersionSixDesign,
  type VersionSixteenDesign,
  type VersionTenDesign,
  type VersionThirteenDesign,
  type VersionTwelveDesign,
} from "./design.ts";
import { defaultHalo, equalHalo, type HaloSelection, parseHalo } from "./halo.ts";
import {
  defaultIcons,
  type Icons,
  type LauncherStyle,
  parseIcons,
  parseLauncher,
} from "./icons.ts";
import { defaultMutedTuning, type MutedTuning, parseMutedTuning } from "./muted-presence.ts";
import { defaultSounds, parseSounds, type Sounds } from "./sounds.ts";
import { equalSpacing, legacySpacing } from "./spacing.ts";
import { defaultSpirit, equalSpirit, parseSpirit, type SpiritSelection } from "./spirit.ts";
import { defaultTraces, migrateTraces } from "./traces.ts";
import type { CaptureViewport } from "./viewport.ts";

export const themes = ["bright", "quiet", "grayscale"] as const;
export type Theme = (typeof themes)[number];
export const mutedPresences = ["off", "tide", "words", "channels", "labeled", "contacts"] as const;
export const presenceScopes = ["both-muted", "any-muted", "always"] as const;
export type PresenceScope = (typeof presenceScopes)[number];
export type MutedPresence = (typeof mutedPresences)[number];
export const activities = ["steady", "voice"] as const;
export type Activity = (typeof activities)[number];
export const scaleModes = ["speaking", "listening", "idle"] as const;
export const modes = [...scaleModes, "thinking"] as const;
export type Mode = (typeof modes)[number];
export type Scales = Record<(typeof scaleModes)[number], number>;
export const scaleMode = (mode: Mode): keyof Scales => (mode === "thinking" ? "idle" : mode);
export const connections = ["connected", "connecting", "disconnected", "failed"] as const;
export type Connection = (typeof connections)[number];
export const connectionStyles = ["relay", "beacon", "datum"] as const;
export type ConnectionStyle = (typeof connectionStyles)[number];
export const orientations = [
  "portrait",
  "landscape",
  "portrait-reverse",
  "landscape-reverse",
] as const;
export type Orientation = (typeof orientations)[number];
export type PersonaSide = "left" | "right";
export type OrientationFence = { orientation: Orientation; orientationEpoch: number };
export type Layout = {
  horizontalOffsetDp: number;
  appearanceOverrides: AppearanceGroup[];
  scales: Scales;
  verticalOffsetDp: number;
  design: Design;
  halo: HaloSelection;
  spirit: SpiritSelection;
  personaSide: PersonaSide;
};
export type Layouts = Record<Orientation, Layout>;
export type RemainingLayouts =
  | { portraitReverse: Layout; landscapeReverse: Layout }
  | { portrait: Layout; landscape: Layout };
type RemainingLayoutKey = "portraitReverse" | "landscapeReverse" | "portrait" | "landscape";
export type VersionSeventeenLayout = Omit<Layout, "design"> & { design: VersionSeventeenDesign };
export type VersionSixteenLayout = Omit<Layout, "design"> & { design: VersionSixteenDesign };
export type VersionFourteenLayout = Omit<
  VersionSixteenLayout,
  "horizontalOffsetDp" | "appearanceOverrides"
>;
export type VersionThirteenLayout = Omit<VersionFourteenLayout, "design"> & {
  design: VersionThirteenDesign;
};
export type VersionTwelveLayout = Omit<VersionFourteenLayout, "design"> & {
  design: VersionTwelveDesign;
};
export type VersionElevenLayout = Omit<VersionFourteenLayout, "design"> & {
  design: VersionTenDesign;
};
export type Preview = Layout &
  OrientationFence & {
    icons: Icons;
    launcher: LauncherStyle;
    connectionStyle: ConnectionStyle;
    showPushToTalk: boolean;
    sounds: Sounds;
    theme: Theme;
    mutedPresence: MutedPresence;
    presenceScope: PresenceScope;
    mutedTuning: MutedTuning;
    connection: Connection;
    activity: Activity;
    mode: Mode;
  };
export type VisualSettings = Pick<
  Preview,
  | "launcher"
  | "connectionStyle"
  | "icons"
  | "theme"
  | "mutedPresence"
  | "presenceScope"
  | "mutedTuning"
  | "showPushToTalk"
>;
export const visualSettingsFields = [
  "launcher",
  "connectionStyle",
  "icons",
  "theme",
  "mutedPresence",
  "presenceScope",
  "mutedTuning",
  "showPushToTalk",
] as const;
export const connectionPreviews = [
  "off",
  "camera",
  "permission",
  "denied",
  "opening",
  "scanning",
  "unavailable",
  "invalid",
  "found",
  "saving",
  "connecting",
  "failed",
  "rejected",
  "storage-failed",
  "microphone",
  "microphone-denied",
] as const;
export type ConnectionPreview = (typeof connectionPreviews)[number];
export type PhoneState = Preview & {
  protocol: 29;
  connectionPreview: ConnectionPreview;
  savedAppearance: VisualSettings;
  defaultAppearance: VisualSettings;
  savedSounds: Sounds;
  defaultSounds: Sounds;
  sharedAppearance: SharedAppearance;
  savedSharedAppearance: SharedAppearance;
  defaultSharedAppearance: SharedAppearance;
  savedAppearanceOverrides: AppearanceGroup[];
  savedHorizontalOffsetDp: number;
  defaultHorizontalOffsetDp: number;
  otherLayout: Layout;
  savedOtherLayout: Layout;
  remainingLayouts: RemainingLayouts;
  savedRemainingLayouts: RemainingLayouts;
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
  // Legacy receipts retain 1.5; new exports describe the fixed normal Idle scale.
  disconnectedArtboardScale: 1.5 | 1.9;
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
      design: VersionTwelveDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      landscape: VersionTwelveLayout;
    }
  | {
      version: 13;
      design: VersionThirteenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      landscape: VersionThirteenLayout;
    }
  | {
      version: 14;
      design: VersionSixteenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      landscape: VersionFourteenLayout;
    }
  | {
      version: 15;
      design: VersionSixteenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: VersionSixteenSharedAppearance;
      landscape: VersionSixteenLayout;
    }
  | {
      version: 16;
      sounds: Sounds;
      design: VersionSixteenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: VersionSixteenSharedAppearance;
      landscape: VersionSixteenLayout;
    }
  | {
      version: 17;
      sounds: Sounds;
      design: VersionSeventeenDesign;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: VersionSeventeenLayout;
    }
  | {
      version: 18;
      sounds: Sounds;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: Layout;
    }
  | {
      version: 19;
      icons: Icons;
      theme: Theme;
      mutedPresence: MutedPresence;
      presenceScope: PresenceScope;
      mutedTuning: MutedTuning;
      showPushToTalk: boolean;
      sounds: Sounds;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: Layout;
    }
  | {
      version: 20;
      launcher: LauncherStyle;
      icons: Icons;
      theme: Theme;
      mutedPresence: MutedPresence;
      presenceScope: PresenceScope;
      mutedTuning: MutedTuning;
      showPushToTalk: boolean;
      sounds: Sounds;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: Layout;
    }
  | {
      version: 21;
      launcher: LauncherStyle;
      icons: Icons;
      theme: Theme;
      mutedPresence: MutedPresence;
      presenceScope: PresenceScope;
      mutedTuning: MutedTuning;
      showPushToTalk: boolean;
      sounds: Sounds;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: Layout;
      portraitReverse: Layout;
      landscapeReverse: Layout;
    }
  | {
      version: 22;
      connectionStyle: ConnectionStyle;
      launcher: LauncherStyle;
      icons: Icons;
      theme: Theme;
      mutedPresence: MutedPresence;
      presenceScope: PresenceScope;
      mutedTuning: MutedTuning;
      showPushToTalk: boolean;
      sounds: Sounds;
      design: Design;
      halo: HaloSelection;
      spirit: SpiritSelection;
      personaSide: PersonaSide;
      horizontalOffsetDp: number;
      appearanceOverrides: AppearanceGroup[];
      sharedAppearance: SharedAppearance;
      landscape: Layout;
      portraitReverse: Layout;
      landscapeReverse: Layout;
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
  exact(data, [...scaleModes]);
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

function parseShowPushToTalk(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("Invalid push-to-talk visibility");
  return value;
}

export function parseConnectionStyle(value: unknown): ConnectionStyle {
  if (!connectionStyles.includes(value as ConnectionStyle)) throw Error("Invalid connection style");
  return value as ConnectionStyle;
}

export function parsePreview(value: unknown): Preview {
  const data = record(value);
  exact(data, [
    "orientation",
    "orientationEpoch",
    "personaSide",
    "icons",
    "launcher",
    "connectionStyle",
    "showPushToTalk",
    "sounds",
    "theme",
    "mutedPresence",
    "presenceScope",
    "mutedTuning",
    "connection",
    "activity",
    "mode",
    "scales",
    "verticalOffsetDp",
    "horizontalOffsetDp",
    "appearanceOverrides",
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
    icons: parseIcons(data["icons"]),
    launcher: parseLauncher(data["launcher"]),
    connectionStyle: parseConnectionStyle(data["connectionStyle"]),
    showPushToTalk: parseShowPushToTalk(data["showPushToTalk"]),
    sounds: parseSounds(data["sounds"]),
    connection: data["connection"] as Connection,
    activity: data["activity"] as Activity,
    mode: mode(data["mode"]),
    scales: parseScales(data["scales"]),
    verticalOffsetDp: integer(data["verticalOffsetDp"], -200, 200),
    horizontalOffsetDp: integer(data["horizontalOffsetDp"], -200, 200),
    appearanceOverrides: parseAppearanceOverrides(data["appearanceOverrides"]),
    design: parseDesign(data["design"]),
    halo: parseHalo(data["halo"]),
    spirit: parseSpirit(data["spirit"]),
  };
}

export function parseState(value: unknown): PhoneState {
  const data = record(value);
  exact(data, [
    "protocol",
    "connectionPreview",
    "savedAppearance",
    "defaultAppearance",
    "savedSounds",
    "defaultSounds",
    "sharedAppearance",
    "savedSharedAppearance",
    "defaultSharedAppearance",
    "savedAppearanceOverrides",
    "savedHorizontalOffsetDp",
    "defaultHorizontalOffsetDp",
    "otherLayout",
    "savedOtherLayout",
    "remainingLayouts",
    "savedRemainingLayouts",
    "savedPersonaSide",
    "defaultPersonaSide",
    "orientation",
    "orientationEpoch",
    "personaSide",
    "icons",
    "launcher",
    "connectionStyle",
    "showPushToTalk",
    "sounds",
    "theme",
    "mutedPresence",
    "presenceScope",
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
    "horizontalOffsetDp",
    "appearanceOverrides",
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
    data["protocol"] !== 29 ||
    !connectionPreviews.includes(data["connectionPreview"] as ConnectionPreview) ||
    !connections.includes(data["connection"] as Connection) ||
    !activities.includes(data["activity"] as Activity) ||
    typeof data["holding"] !== "boolean" ||
    typeof data["micMuted"] !== "boolean" ||
    typeof data["speakerMuted"] !== "boolean"
  )
    throw Error("Invalid phone state");
  const state: PhoneState = {
    protocol: 29,
    connectionPreview: data["connectionPreview"] as ConnectionPreview,
    savedAppearance: parseVisualSettings(data["savedAppearance"]),
    defaultAppearance: parseVisualSettings(data["defaultAppearance"]),
    savedSounds: parseSounds(data["savedSounds"]),
    defaultSounds: parseSounds(data["defaultSounds"]),
    sharedAppearance: parseSharedAppearance(data["sharedAppearance"]),
    savedSharedAppearance: parseSharedAppearance(data["savedSharedAppearance"]),
    defaultSharedAppearance: parseSharedAppearance(data["defaultSharedAppearance"]),
    savedAppearanceOverrides: parseAppearanceOverrides(data["savedAppearanceOverrides"]),
    savedHorizontalOffsetDp: integer(data["savedHorizontalOffsetDp"], -200, 200),
    defaultHorizontalOffsetDp: integer(data["defaultHorizontalOffsetDp"], -200, 200),
    otherLayout: parseLayout(data["otherLayout"]),
    savedOtherLayout: parseLayout(data["savedOtherLayout"]),
    remainingLayouts: parseRemainingLayouts(
      data["remainingLayouts"],
      parseOrientationFence(data).orientation,
    ),
    savedRemainingLayouts: parseRemainingLayouts(
      data["savedRemainingLayouts"],
      parseOrientationFence(data).orientation,
    ),
    savedPersonaSide: parsePersonaSide(data["savedPersonaSide"]),
    defaultPersonaSide: parsePersonaSide(data["defaultPersonaSide"]),
    ...parseOrientationFence(data),
    personaSide: parsePersonaSide(data["personaSide"]),
    ...parseSessionModes(data),
    icons: parseIcons(data["icons"]),
    launcher: parseLauncher(data["launcher"]),
    connectionStyle: parseConnectionStyle(data["connectionStyle"]),
    showPushToTalk: parseShowPushToTalk(data["showPushToTalk"]),
    sounds: parseSounds(data["sounds"]),
    connection: data["connection"] as Connection,
    activity: data["activity"] as Activity,
    revision: integer(data["revision"]),
    holding: data["holding"],
    mode: mode(data["mode"]),
    scales: parseScales(data["scales"]),
    savedScales: parseScales(data["savedScales"]),
    defaults: parseScales(data["defaults"]),
    verticalOffsetDp: integer(data["verticalOffsetDp"], -200, 200),
    horizontalOffsetDp: integer(data["horizontalOffsetDp"], -200, 200),
    appearanceOverrides: parseAppearanceOverrides(data["appearanceOverrides"]),
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
  if (
    !Object.values(stateLayouts(state)).every((layout) =>
      equalSpacing(state.design.spacing, layout.design.spacing),
    ) ||
    !Object.values(savedStateLayouts(state)).every((layout) =>
      equalSpacing(state.savedDesign.spacing, layout.design.spacing),
    )
  )
    throw Error("Mismatched shared spacing");
  return state;
}

export function parseProfile(text: string): Profile {
  if (text.length > 8192) throw Error("Profile too large");
  const data = record(JSON.parse(text));
  exact(data, [
    "version",
    ...(data["version"] === 22
      ? visualSettingsFields
      : data["version"] === 20 || data["version"] === 21
        ? visualSettingsFields.filter((field) => field !== "connectionStyle")
        : data["version"] === 19
          ? visualSettingsFields.filter(
              (field) => field !== "launcher" && field !== "connectionStyle",
            )
          : []),
    ...(data["version"] === 16 ||
    data["version"] === 17 ||
    data["version"] === 18 ||
    data["version"] === 19 ||
    data["version"] === 20 ||
    data["version"] === 21 ||
    data["version"] === 22
      ? ["sounds"]
      : []),
    "scaleMultipliers",
    "verticalOffsetDp",
    "connectedArtboardScale",
    "disconnectedArtboardScale",
    "savedAtEpochMs",
    ...(data["version"] === 15 ||
    data["version"] === 16 ||
    data["version"] === 17 ||
    data["version"] === 18 ||
    data["version"] === 19 ||
    data["version"] === 20 ||
    data["version"] === 21 ||
    data["version"] === 22
      ? ["horizontalOffsetDp", "appearanceOverrides", "sharedAppearance"]
      : []),
    ...([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(data["version"] as number)
      ? [
          "personaSide",
          "landscape",
          ...(data["version"] === 21 || data["version"] === 22
            ? ["portraitReverse", "landscapeReverse"]
            : []),
        ]
      : []),
    ...([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    )
      ? ["design"]
      : []),
    ...([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    )
      ? ["halo"]
      : []),
    ...([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    )
      ? ["spirit"]
      : []),
  ]);
  if (
    ![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    ) ||
    data["connectedArtboardScale"] !== 1.9 ||
    ![1.5, 1.9].includes(data["disconnectedArtboardScale"] as number)
  ) {
    throw Error("Unsupported profile");
  }
  if (data["version"] === 22) visualSettingsOf(data);
  else if (data["version"] === 20 || data["version"] === 21)
    visualSettingsOf({ ...data, connectionStyle: "relay" });
  else if (data["version"] === 19)
    visualSettingsOf({ ...data, launcher: "current", connectionStyle: "relay" });
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
  if (
    data["version"] === 16 ||
    data["version"] === 17 ||
    data["version"] === 18 ||
    data["version"] === 19 ||
    data["version"] === 20 ||
    data["version"] === 21 ||
    data["version"] === 22
  )
    parseSounds(data["sounds"]);
  if (data["version"] === 3) parseLegacyDesign(data["design"]);
  if (data["version"] === 4 || data["version"] === 5) parsePreviousDesign(data["design"]);
  if (data["version"] === 6) parseVersionSixDesign(data["design"]);
  if (data["version"] === 7) parseVersionSevenDesign(data["design"]);
  if (data["version"] === 8) parseVersionEightDesign(data["design"]);
  if (data["version"] === 9) parseVersionNineDesign(data["design"]);
  if (data["version"] === 10 || data["version"] === 11) parseVersionTenDesign(data["design"]);
  if (data["version"] === 12) parseVersionTwelveDesign(data["design"]);
  if (data["version"] === 13) parseVersionThirteenDesign(data["design"]);
  if (
    data["version"] === 18 ||
    data["version"] === 19 ||
    data["version"] === 20 ||
    data["version"] === 21 ||
    data["version"] === 22
  )
    parseDesign(data["design"]);
  if (data["version"] === 17) parseVersionSeventeenDesign(data["design"]);
  if (data["version"] === 14 || data["version"] === 15 || data["version"] === 16)
    parseVersionSixteenDesign(data["design"]);
  if (
    data["version"] === 15 ||
    data["version"] === 16 ||
    data["version"] === 17 ||
    data["version"] === 18 ||
    data["version"] === 19 ||
    data["version"] === 20 ||
    data["version"] === 21 ||
    data["version"] === 22
  ) {
    integer(data["horizontalOffsetDp"], -200, 200);
    parseAppearanceOverrides(data["appearanceOverrides"]);
    if (
      data["version"] === 17 ||
      data["version"] === 18 ||
      data["version"] === 19 ||
      data["version"] === 20 ||
      data["version"] === 21 ||
      data["version"] === 22
    )
      parseSharedAppearance(data["sharedAppearance"]);
    else parseVersionSixteenSharedAppearance(data["sharedAppearance"]);
  }
  if ([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(data["version"] as number)) {
    parsePersonaSide(data["personaSide"]);
    if (data["version"] === 11) parseVersionElevenLayout(data["landscape"]);
    else if (data["version"] === 12) parseVersionTwelveLayout(data["landscape"]);
    else if (data["version"] === 13) parseVersionThirteenLayout(data["landscape"]);
    else if (data["version"] === 14) parseVersionFourteenLayout(data["landscape"]);
    else if (data["version"] === 15 || data["version"] === 16)
      parseVersionSixteenLayout(data["landscape"]);
    else if (data["version"] === 17) parseVersionSeventeenLayout(data["landscape"]);
    else data["landscape"] = parseLayout(data["landscape"]);
    if (data["version"] === 21 || data["version"] === 22) {
      data["portraitReverse"] = parseLayout(data["portraitReverse"]);
      data["landscapeReverse"] = parseLayout(data["landscapeReverse"]);
    }
  }
  if (
    [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    )
  ) {
    parseSpirit(data["spirit"]);
  }
  if (
    [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(
      data["version"] as number,
    )
  )
    data["halo"] = parseHalo(data["halo"]);
  if (
    (data["version"] === 17 ||
      data["version"] === 18 ||
      data["version"] === 19 ||
      data["version"] === 20 ||
      data["version"] === 21 ||
      data["version"] === 22) &&
    !equalSpacing(
      (data["version"] === 18 ||
      data["version"] === 19 ||
      data["version"] === 20 ||
      data["version"] === 21 ||
      data["version"] === 22
        ? parseDesign(data["design"])
        : parseVersionSeventeenDesign(data["design"])
      ).spacing,
      (data["version"] === 18 ||
      data["version"] === 19 ||
      data["version"] === 20 ||
      data["version"] === 21 ||
      data["version"] === 22
        ? parseLayout(data["landscape"])
        : parseVersionSeventeenLayout(data["landscape"])
      ).design.spacing,
    )
  )
    throw Error("Mismatched shared spacing");
  if (
    (data["version"] === 21 || data["version"] === 22) &&
    ![data["portraitReverse"], data["landscapeReverse"]].every((layout) =>
      equalSpacing(parseDesign(data["design"]).spacing, parseLayout(layout).design.spacing),
    )
  )
    throw Error("Mismatched shared spacing");
  return data as Profile;
}

export function profileDesign(profile: Profile): Design {
  if (
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
  )
    return structuredClone(profile.design);
  const previous = profileLegacyDesign(profile);
  return { ...previous, controlsWithoutPttDp: previous.controlsHeightDp };
}
function profileLegacyDesign(profile: Profile): VersionSeventeenDesign {
  if (
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
  )
    return structuredClone(profile.design);
  if (profile.version === 14 || profile.version === 15 || profile.version === 16)
    return { ...structuredClone(profile.design), traces: migrateTraces(profile.design.traces) };
  if (profile.version === 13)
    return {
      ...structuredClone(profile.design),
      traces: migrateTraces(profile.design.traces),
    };
  if (profile.version === 12)
    return {
      ...structuredClone(profile.design),
      traces: migrateTraces(profile.design.traces),
      spacing: { ...profile.design.spacing, paddingDp: -1 },
    };
  if (profile.version === 10 || profile.version === 11)
    return {
      ...structuredClone(profile.design),
      traces: migrateTraces(profile.design.traces),
      spacing: legacySpacing(),
    };
  if (profile.version === 9)
    return {
      ...profile.design,
      traces: migrateTraces(profile.design.traces),
      spacing: legacySpacing(),
    };
  if (profile.version !== 2 && profile.version !== 3)
    return {
      ...profile.design,
      mute: "rockers",
      hold: "rocker",
      composition: "traces",
      traces: defaultTraces(),
      spacing: legacySpacing(),
    };
  return { ...structuredClone(defaultDesign), spacing: legacySpacing() };
}

export function profileHalo(profile: Profile): HaloSelection {
  return profile.version === 5 ||
    profile.version === 6 ||
    profile.version === 7 ||
    profile.version === 8 ||
    profile.version === 9 ||
    profile.version === 10 ||
    profile.version === 11 ||
    profile.version === 12 ||
    profile.version === 13 ||
    profile.version === 14 ||
    profile.version === 15 ||
    profile.version === 16 ||
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
    ? profile.halo
    : defaultHalo();
}

export function profileSpirit(profile: Profile): SpiritSelection {
  return profile.version === 7 ||
    profile.version === 8 ||
    profile.version === 9 ||
    profile.version === 10 ||
    profile.version === 11 ||
    profile.version === 12 ||
    profile.version === 13 ||
    profile.version === 14 ||
    profile.version === 15 ||
    profile.version === 16 ||
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
    ? profile.spirit
    : defaultSpirit();
}

export function previewOf(state: Preview): Preview {
  return {
    orientation: state.orientation,
    orientationEpoch: state.orientationEpoch,
    personaSide: state.personaSide,
    icons: { ...state.icons },
    launcher: state.launcher,
    connectionStyle: state.connectionStyle,
    showPushToTalk: state.showPushToTalk,
    sounds: { ...state.sounds },
    theme: state.theme,
    mutedPresence: state.mutedPresence,
    presenceScope: state.presenceScope,
    mutedTuning: { ...state.mutedTuning },
    connection: state.connection,
    activity: state.activity,
    mode: state.mode,
    scales: { ...state.scales },
    verticalOffsetDp: state.verticalOffsetDp,
    horizontalOffsetDp: state.horizontalOffsetDp,
    appearanceOverrides: [...state.appearanceOverrides],
    design: structuredClone(state.design),
    halo: structuredClone(state.halo),
    spirit: { ...state.spirit },
  };
}

export function equalScales(a: Scales, b: Scales): boolean {
  return scaleModes.every((mode) => a[mode] === b[mode]);
}

export interface Phone {
  state: PhoneState;
  connected: boolean;
  disconnectReason?: string;
  reconnecting?: boolean;
  generation?: number;
  request(
    command: Record<string, unknown>,
  ): Promise<{ state: PhoneState; profile?: string; viewport?: CaptureViewport }>;
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

export function otherOrientation(orientation: Orientation): Orientation {
  switch (orientation) {
    case "portrait":
      return "landscape";
    case "landscape":
      return "portrait";
    case "portrait-reverse":
      return "landscape-reverse";
    case "landscape-reverse":
      return "portrait-reverse";
  }
}

export function remainingLayoutKeys(
  orientation: Orientation,
): readonly ["portraitReverse", "landscapeReverse"] | readonly ["portrait", "landscape"] {
  return orientation === "portrait" || orientation === "landscape"
    ? ["portraitReverse", "landscapeReverse"]
    : ["portrait", "landscape"];
}

function orientationForRemainingKey(key: RemainingLayoutKey): Orientation {
  return key === "portraitReverse"
    ? "portrait-reverse"
    : key === "landscapeReverse"
      ? "landscape-reverse"
      : key;
}

export function parseRemainingLayouts(value: unknown, orientation: Orientation): RemainingLayouts {
  const data = record(value);
  const keys = remainingLayoutKeys(orientation);
  exact(data, [...keys]);
  return Object.fromEntries(keys.map((key) => [key, parseLayout(data[key])])) as RemainingLayouts;
}

export function stateLayouts(state: PhoneState): Layouts {
  const active = layoutOf(state);
  const other = layoutOf(state.otherLayout);
  const remaining = state.remainingLayouts;
  return Object.fromEntries([
    [state.orientation, active],
    [otherOrientation(state.orientation), other],
    ...Object.entries(remaining).map(([key, layout]) => [
      orientationForRemainingKey(key as RemainingLayoutKey),
      layoutOf(layout),
    ]),
  ]) as Layouts;
}

export function savedStateLayouts(state: PhoneState): Layouts {
  const active = layoutOf({
    ...state,
    scales: state.savedScales,
    verticalOffsetDp: state.savedVerticalOffsetDp,
    horizontalOffsetDp: state.savedHorizontalOffsetDp,
    appearanceOverrides: state.savedAppearanceOverrides,
    design: state.savedDesign,
    halo: state.savedHalo,
    spirit: state.savedSpirit,
    personaSide: state.savedPersonaSide,
  });
  const other = layoutOf(state.savedOtherLayout);
  const remaining = state.savedRemainingLayouts;
  return Object.fromEntries([
    [state.orientation, active],
    [otherOrientation(state.orientation), other],
    ...Object.entries(remaining).map(([key, layout]) => [
      orientationForRemainingKey(key as RemainingLayoutKey),
      layoutOf(layout),
    ]),
  ]) as Layouts;
}

export function parsePersonaSide(value: unknown): PersonaSide {
  if (value !== "left" && value !== "right") throw Error("Invalid Persona side");
  return value;
}

export function parseLayout(value: unknown): Layout {
  const data = record(value);
  const { horizontalOffsetDp, appearanceOverrides, ...previous } = data;
  return {
    ...parseVersionElevenLayoutFields(previous),
    design: parseDesign(previous["design"]),
    horizontalOffsetDp: integer(horizontalOffsetDp, -200, 200),
    appearanceOverrides: parseAppearanceOverrides(appearanceOverrides),
  };
}
export function parseVersionSeventeenLayout(value: unknown): VersionSeventeenLayout {
  const { horizontalOffsetDp, appearanceOverrides, ...previous } = record(value);
  const fields = parseVersionElevenLayoutFields(previous);
  return {
    ...fields,
    design: parseVersionSeventeenDesign(fields.design),
    horizontalOffsetDp: integer(horizontalOffsetDp, -200, 200),
    appearanceOverrides: parseAppearanceOverrides(appearanceOverrides),
  };
}
export function parseVersionSixteenLayout(value: unknown): VersionSixteenLayout {
  const { horizontalOffsetDp, appearanceOverrides, ...previous } = record(value);
  return {
    ...parseVersionFourteenLayout(previous),
    horizontalOffsetDp: integer(horizontalOffsetDp, -200, 200),
    appearanceOverrides: parseAppearanceOverrides(appearanceOverrides),
  };
}
export function parseVersionFourteenLayout(value: unknown): VersionFourteenLayout {
  const previous = parseVersionElevenLayoutFields(value);
  return { ...previous, design: parseVersionSixteenDesign(previous.design) };
}
export function parseVersionThirteenLayout(value: unknown): VersionThirteenLayout {
  const previous = parseVersionElevenLayoutFields(value);
  return { ...previous, design: parseVersionThirteenDesign(previous.design) };
}
export function parseVersionTwelveLayout(value: unknown): VersionTwelveLayout {
  const previous = parseVersionElevenLayoutFields(value);
  return { ...previous, design: parseVersionTwelveDesign(previous.design) };
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
    horizontalOffsetDp: value.horizontalOffsetDp,
    appearanceOverrides: [...value.appearanceOverrides],
    design: value.design,
    halo: value.halo,
    spirit: value.spirit,
    personaSide: value.personaSide,
  });
}

export function canonicalLandscapeLayout(): Layout {
  return {
    scales: { speaking: 78, listening: 58, idle: 78 },
    verticalOffsetDp: 0,
    horizontalOffsetDp: 0,
    appearanceOverrides: [],
    design: structuredClone(defaultDesign),
    halo: defaultHalo(),
    spirit: defaultSpirit(),
    personaSide: "left",
  };
}

function profileLegacyLayout(profile: Profile, orientation: Orientation): Layout {
  const previous = profileSourceLayout(profile, orientation);
  return {
    ...previous,
    design: {
      ...previous.design,
      controlsWithoutPttDp:
        profile.version === 18 ||
        profile.version === 19 ||
        profile.version === 20 ||
        profile.version === 21 ||
        profile.version === 22
          ? (previous.design as Design).controlsWithoutPttDp
          : previous.design.controlsHeightDp,
    },
  };
}
function profileSourceLayout(profile: Profile, orientation: Orientation): VersionSeventeenLayout {
  if (orientation === "portrait-reverse")
    return profile.version === 21 || profile.version === 22
      ? structuredClone(profile.portraitReverse)
      : profileSourceLayout(profile, "portrait");
  if (orientation === "landscape-reverse")
    return profile.version === 21 || profile.version === 22
      ? structuredClone(profile.landscapeReverse)
      : profileSourceLayout(profile, "landscape");
  if (orientation === "landscape") {
    if (
      profile.version === 17 ||
      profile.version === 18 ||
      profile.version === 19 ||
      profile.version === 20 ||
      profile.version === 21 ||
      profile.version === 22
    )
      return structuredClone(profile.landscape);
    if (profile.version === 15 || profile.version === 16)
      return {
        ...structuredClone(profile.landscape),
        design: {
          ...structuredClone(profile.landscape.design),
          traces: migrateTraces(profile.landscape.design.traces),
        },
      };
    if (profile.version === 14)
      return {
        ...structuredClone(profile.landscape),
        design: {
          ...structuredClone(profile.landscape.design),
          traces: migrateTraces(profile.landscape.design.traces),
        },
        horizontalOffsetDp: 0,
        appearanceOverrides: [],
      };
    if (profile.version === 13)
      return {
        ...structuredClone(profile.landscape),
        horizontalOffsetDp: 0,
        appearanceOverrides: [],
        design: {
          ...structuredClone(profile.landscape.design),
          traces: migrateTraces(profile.landscape.design.traces),
        },
      };
    if (profile.version === 12)
      return {
        ...structuredClone(profile.landscape),
        horizontalOffsetDp: 0,
        appearanceOverrides: [],
        design: {
          ...structuredClone(profile.landscape.design),
          traces: migrateTraces(profile.landscape.design.traces),
          spacing: { ...profile.landscape.design.spacing, paddingDp: -1 },
        },
      };
    if (profile.version === 11)
      return {
        ...structuredClone(profile.landscape),
        horizontalOffsetDp: 0,
        appearanceOverrides: [],
        design: {
          ...structuredClone(profile.landscape.design),
          traces: migrateTraces(profile.landscape.design.traces),
          spacing: legacySpacing(),
        },
      };
    const landscape = canonicalLandscapeLayout();
    return { ...landscape, design: { ...landscape.design, spacing: legacySpacing() } };
  }
  return {
    scales: {
      speaking: Math.round(profile.scaleMultipliers.speaking * 100),
      listening: Math.round(profile.scaleMultipliers.listening * 100),
      idle: Math.round(profile.scaleMultipliers.idle * 100),
    },
    verticalOffsetDp: profile.verticalOffsetDp,
    horizontalOffsetDp:
      profile.version === 15 ||
      profile.version === 16 ||
      profile.version === 17 ||
      profile.version === 18 ||
      profile.version === 19 ||
      profile.version === 20 ||
      profile.version === 21 ||
      profile.version === 22
        ? profile.horizontalOffsetDp
        : 0,
    appearanceOverrides:
      profile.version === 15 ||
      profile.version === 16 ||
      profile.version === 17 ||
      profile.version === 18 ||
      profile.version === 19 ||
      profile.version === 20 ||
      profile.version === 21 ||
      profile.version === 22
        ? [...profile.appearanceOverrides]
        : [],
    design: profileDesign(profile),
    halo: structuredClone(profileHalo(profile)),
    spirit: { ...profileSpirit(profile) },
    personaSide:
      profile.version === 11 ||
      profile.version === 12 ||
      profile.version === 13 ||
      profile.version === 14 ||
      profile.version === 15 ||
      profile.version === 16 ||
      profile.version === 17 ||
      profile.version === 18 ||
      profile.version === 19 ||
      profile.version === 20 ||
      profile.version === 21 ||
      profile.version === 22
        ? profile.personaSide
        : "left",
  };
}

export function equalLayout(a: Layout, b: Layout): boolean {
  return (
    equalScales(a.scales, b.scales) &&
    a.verticalOffsetDp === b.verticalOffsetDp &&
    a.horizontalOffsetDp === b.horizontalOffsetDp &&
    a.appearanceOverrides.join(",") === b.appearanceOverrides.join(",") &&
    equalDesign(a.design, b.design) &&
    equalHalo(a.halo, b.halo) &&
    equalSpirit(a.spirit, b.spirit) &&
    a.personaSide === b.personaSide
  );
}

export function parseSessionModes(data: Record<string, unknown>): {
  theme: Theme;
  mutedPresence: MutedPresence;
  presenceScope: PresenceScope;
  mutedTuning: MutedTuning;
} {
  if (!themes.includes(data["theme"] as Theme)) throw Error("Invalid theme");
  if (!mutedPresences.includes(data["mutedPresence"] as MutedPresence))
    throw Error("Invalid muted presence");
  if (!presenceScopes.includes(data["presenceScope"] as PresenceScope))
    throw Error("Invalid indicator scope");
  return {
    theme: data["theme"] as Theme,
    mutedPresence: data["mutedPresence"] as MutedPresence,
    presenceScope: data["presenceScope"] as PresenceScope,
    mutedTuning: parseMutedTuning(data["mutedTuning"]),
  };
}

export function defaultPortraitLayout(): Layout {
  const layout = canonicalLandscapeLayout();
  return {
    ...layout,
    scales: { speaking: 78, listening: 56, idle: 78 },
    verticalOffsetDp: -22,
    design: {
      ...layout.design,
      controlsHeightDp: 387,
      controlsWithoutPttDp: 387,
      holdSharePercent: 40.9,
      traces: {
        ...layout.design.traces,
        stancePercent: 130,
        weightPercent: 175,
      },
    },
    halo: { ...layout.halo, variant: "contained" },
    spirit: { ...layout.spirit, persona: "follow" },
  };
}

export function defaultSharedAppearance(): SharedAppearance {
  return appearanceOf(defaultPortraitLayout());
}
export function defaultLandscapeLayout(): Layout {
  return applySharedAppearance(canonicalLandscapeLayout(), defaultSharedAppearance());
}
export function profileSharedAppearance(profile: Profile): SharedAppearance {
  if (
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
  )
    return structuredClone(profile.sharedAppearance);
  if (profile.version === 15 || profile.version === 16) {
    const { offshootPercent: _, ...traces } = profile.sharedAppearance.traces;
    return structuredClone({ ...profile.sharedAppearance, traces });
  }
  return appearanceOf(profileLegacyLayout(profile, "portrait"));
}
export function profileLayout(profile: Profile, orientation: Orientation): Layout {
  const local = profileLegacyLayout(profile, orientation);
  if (
    profile.version !== 17 &&
    profile.version !== 18 &&
    profile.version !== 19 &&
    profile.version !== 20 &&
    profile.version !== 21 &&
    profile.version !== 22 &&
    (orientation === "landscape" || orientation === "landscape-reverse")
  )
    local.design.spacing = { ...profileDesign(profile).spacing };
  // Current receipts already contain effective values; do not mask a mismatched snapshot.
  if (
    profile.version === 15 ||
    profile.version === 16 ||
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
  )
    return local;
  const shared = profileSharedAppearance(profile);
  if (orientation === "landscape" || orientation === "landscape-reverse") {
    const legacy = appearanceOf(local);
    const canonical = appearanceOf(canonicalLandscapeLayout());
    local.appearanceOverrides = appearanceGroups.filter(
      (group) =>
        !equalAppearanceGroup(legacy, shared, group) &&
        !equalAppearanceGroup(legacy, canonical, group),
    );
  }
  return applySharedAppearance(local, shared);
}

export function profileSounds(profile: Profile): Sounds {
  return profile.version === 16 ||
    profile.version === 17 ||
    profile.version === 18 ||
    profile.version === 19 ||
    profile.version === 20 ||
    profile.version === 21 ||
    profile.version === 22
    ? { ...profile.sounds }
    : defaultSounds();
}

export function parseVisualSettings(value: unknown): VisualSettings {
  const data = record(value);
  exact(data, [...visualSettingsFields]);
  return {
    icons: parseIcons(data["icons"]),
    launcher: parseLauncher(data["launcher"]),
    connectionStyle: parseConnectionStyle(data["connectionStyle"]),
    ...parseSessionModes(data),
    showPushToTalk: parseShowPushToTalk(data["showPushToTalk"]),
  };
}
export function visualSettingsOf(value: unknown): VisualSettings {
  const data = record(value);
  return parseVisualSettings(
    Object.fromEntries(visualSettingsFields.map((field) => [field, data[field]])),
  );
}
export function defaultVisualSettings(): VisualSettings {
  return {
    icons: defaultIcons(),
    launcher: "current",
    connectionStyle: "relay",
    theme: "bright",
    mutedPresence: "tide",
    presenceScope: "any-muted",
    mutedTuning: defaultMutedTuning(),
    showPushToTalk: true,
  };
}
export function profileVisualSettings(profile: Profile): VisualSettings {
  return profile.version === 22
    ? visualSettingsOf(profile)
    : profile.version === 20 || profile.version === 21
      ? visualSettingsOf({ ...profile, connectionStyle: "relay" })
      : profile.version === 19
        ? visualSettingsOf({ ...profile, launcher: "current", connectionStyle: "relay" })
        : defaultVisualSettings();
}
export function equalVisualSettings(a: VisualSettings, b: VisualSettings): boolean {
  return (
    a.launcher === b.launcher &&
    a.connectionStyle === b.connectionStyle &&
    a.icons.channels === b.icons.channels &&
    a.icons.push === b.icons.push &&
    a.theme === b.theme &&
    a.mutedPresence === b.mutedPresence &&
    a.presenceScope === b.presenceScope &&
    a.showPushToTalk === b.showPushToTalk &&
    (
      [
        "textSizeSp",
        "brightnessPercent",
        "driftPercent",
        "breathPercent",
        "cycleSeconds",
        "motion",
      ] as const
    ).every((field) => a.mutedTuning[field] === b.mutedTuning[field])
  );
}
