import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appearanceGroups,
  appearanceOf,
  mergeAppearanceEdit,
  parseSharedAppearance,
} from "../src/appearance.ts";
import { defaultDesign, parseDesign } from "../src/design.ts";
import { PhoneConnection } from "../src/device.ts";
import { defaultHalo, haloMotionFields, parseHalo, thinkingWingspanBounds } from "../src/halo.ts";
import { balancedHandedLayout, withPersonaSide } from "../src/handedness.ts";
import {
  defaultIcons,
  iconCatalog,
  iconPreviewFiles,
  iconStyles,
  launcherConcepts,
  pushIconPreview,
  pushIconStyles,
  safeCreditLink,
} from "../src/icons.ts";
import { parseArgs } from "../src/main.ts";
import {
  defaultMutedTuning,
  mutedTuningAmounts,
  mutedTuningBounds,
  mutedTuningFields,
  parseMutedTuning,
} from "../src/muted-presence.ts";
import {
  defaultLandscapeLayout,
  defaultPortraitLayout,
  defaultSharedAppearance,
  defaultVisualSettings,
  equalLayout,
  equalVisualSettings,
  layoutOf,
  mutedPresences,
  type Phone,
  type PhoneState,
  type Profile,
  parsePreview,
  parseProfile,
  parseScales,
  parseState,
  presenceScopes,
  previewOf,
  profileDesign,
  profileHalo,
  profileLayout,
  profileSharedAppearance,
  profileSounds,
  profileSpirit,
  profileVisualSettings,
  sameOrientation,
  stateLayouts,
  visualSettingsOf,
} from "../src/protocol.ts";
import { resetPreview } from "../src/resets.ts";
import { serveConfigurator } from "../src/server.ts";
import { defaultSounds, parseSounds, soundFamilies } from "../src/sounds.ts";
import {
  defaultSpacing,
  legacySpacing,
  parseSpacing,
  spacingBounds,
  spacingFields,
} from "../src/spacing.ts";
import { defaultSpirit, parseSpirit } from "../src/spirit.ts";
import {
  defaultTraces,
  migrateTraces,
  parseTraces,
  type TraceSelection,
  traceAmountFields,
  traceBounds,
  tracePatterns,
  traceTipFields,
} from "../src/traces.ts";

const defaults = { speaking: 78, listening: 58, idle: 78 };
function withoutThinkingWingspan<T>(value: T): T {
  const copy = structuredClone(value) as unknown;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const data = item as Record<string, unknown>;
    if ("variant" in data && "colors" in data && "ringSpreadPercent" in data)
      delete data["thinkingWingspan"];
    for (const child of Object.values(data)) visit(child);
  };
  visit(copy);
  return copy as T;
}
function expectLegacyProfile(actual: Profile, expected: unknown): void {
  expect(Bun.deepEquals(withoutThinkingWingspan(actual), expected)).toBe(true);
}
const initial = (): PhoneState => ({
  protocol: 30,
  connectionPreview: "off",
  launcher: "current",
  connectionStyle: "relay",
  savedAppearance: defaultVisualSettings(),
  defaultAppearance: defaultVisualSettings(),
  icons: { channels: "current", push: "current" },
  showPushToTalk: true,
  sounds: defaultSounds(),
  savedSounds: defaultSounds(),
  defaultSounds: defaultSounds(),
  horizontalOffsetDp: 0,
  savedHorizontalOffsetDp: 0,
  defaultHorizontalOffsetDp: 0,
  appearanceOverrides: [...appearanceGroups],
  savedAppearanceOverrides: [...appearanceGroups],
  sharedAppearance: defaultSharedAppearance(),
  savedSharedAppearance: defaultSharedAppearance(),
  defaultSharedAppearance: appearanceOf({
    design: defaultDesign,
    halo: defaultHalo(),
    spirit: defaultSpirit(),
  }),
  presenceScope: "any-muted",
  mutedTuning: defaultMutedTuning(),
  theme: "bright",
  mutedPresence: "tide",
  orientation: "portrait",
  orientationEpoch: 0,
  personaSide: "left",
  savedPersonaSide: "left",
  defaultPersonaSide: "left",
  otherLayout: defaultLandscapeLayout(),
  savedOtherLayout: defaultLandscapeLayout(),
  remainingLayouts: {
    portraitReverse: defaultPortraitLayout(),
    landscapeReverse: defaultLandscapeLayout(),
  },
  savedRemainingLayouts: {
    portraitReverse: defaultPortraitLayout(),
    landscapeReverse: defaultLandscapeLayout(),
  },
  activity: "steady",
  connection: "connected",
  revision: 0,
  holding: false,
  mode: "speaking",
  scales: { ...defaults },
  savedScales: { ...defaults },
  defaults: { ...defaults },
  verticalOffsetDp: 35,
  savedVerticalOffsetDp: 35,
  defaultVerticalOffsetDp: 35,
  design: structuredClone(defaultDesign),
  savedDesign: structuredClone(defaultDesign),
  defaultDesign: structuredClone(defaultDesign),
  halo: defaultHalo(),
  savedHalo: defaultHalo(),
  defaultHalo: defaultHalo(),
  spirit: defaultSpirit(),
  savedSpirit: defaultSpirit(),
  defaultSpirit: defaultSpirit(),
  micMuted: true,
  speakerMuted: false,
});
const profile = (state: PhoneState): Extract<Profile, { version: 10 }> =>
  withoutThinkingWingspan({
    version: 10,
    spirit: { ...state.spirit },
    design: versionTenDesign(state.design),
    halo: structuredClone(state.halo),
    scaleMultipliers: {
      speaking: state.scales.speaking / 100,
      listening: state.scales.listening / 100,
      idle: state.scales.idle / 100,
    },
    verticalOffsetDp: state.verticalOffsetDp,
    connectedArtboardScale: 1.9,
    disconnectedArtboardScale: 1.5,
    savedAtEpochMs: 1788917295182,
  }) as Extract<Profile, { version: 10 }>;
const currentProfile = (state: PhoneState): Extract<Profile, { version: 18 }> => {
  const portrait = state.orientation === "portrait" ? layoutOf(state) : state.otherLayout;
  return withoutThinkingWingspan({
    ...profile({ ...state, ...portrait }),
    version: 18,
    sounds: { ...state.sounds },
    horizontalOffsetDp: portrait.horizontalOffsetDp,
    appearanceOverrides: [...portrait.appearanceOverrides],
    sharedAppearance: structuredClone(state.sharedAppearance),
    design: structuredClone(portrait.design),
    personaSide: portrait.personaSide,
    landscape: layoutOf(state.orientation === "landscape" ? state : state.otherLayout),
  }) as Extract<Profile, { version: 18 }>;
};
const completeProfile = (state: PhoneState): Extract<Profile, { version: 23 }> => {
  const layouts = stateLayouts(state);
  return {
    ...currentProfile(state),
    version: 23,
    halo: structuredClone(layouts.portrait.halo),
    sharedAppearance: structuredClone(state.sharedAppearance),
    landscape: layouts.landscape,
    portraitReverse: layouts["portrait-reverse"],
    landscapeReverse: layouts["landscape-reverse"],
    ...visualSettingsOf(state),
  };
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakePhone implements Phone {
  state = initial();
  connected = true;
  generation = 1;
  calls: Record<string, unknown>[] = [];
  refuseSave = false;
  wrongOffsetReceipt = false;
  wrongHiddenExtentReceipt = false;
  wrongSoundsReceipt: "family" | "volumePercent" | undefined;
  wrongConnectionStyleReceipt = false;
  changeSoundsDuringSave = false;
  wrongSpiritReceipt: "surface" | "strengthPercent" | "persona" | undefined;
  oldReceipt = false;
  wrongTraceReceipt: keyof TraceSelection | undefined;
  changeDuringSave = false;
  rotateDuringSave = false;
  wrongOtherReceipt = false;
  wrongSpacingReceipt: (typeof spacingFields)[number] | undefined;
  wrongSideReceipt = false;
  wrongSharedReceipt = false;
  wrongOverrideReceipt = false;
  wrongHorizontalReceipt = false;
  wrongHaloReceipt:
    | "variant"
    | "color"
    | "containedSizePercent"
    | "thinkingWingspan"
    | (typeof haloMotionFields)[number]
    | undefined;
  wrongDesignReceipt: "height" | "share" | "mute" | "hold" | "composition" | undefined;
  rotate() {
    const previous = layoutOf(this.state);
    const previousSaved = {
      horizontalOffsetDp: this.state.savedHorizontalOffsetDp,
      appearanceOverrides: [...this.state.savedAppearanceOverrides],
      scales: this.state.savedScales,
      verticalOffsetDp: this.state.savedVerticalOffsetDp,
      design: this.state.savedDesign,
      halo: this.state.savedHalo,
      spirit: this.state.savedSpirit,
      personaSide: this.state.savedPersonaSide,
    };
    const saved = this.state.savedOtherLayout;
    this.state = {
      ...this.state,
      ...this.state.otherLayout,
      otherLayout: previous,
      orientation: this.state.orientation === "portrait" ? "landscape" : "portrait",
      orientationEpoch: this.state.orientationEpoch + 1,
      revision: this.state.revision + 1,
      savedHorizontalOffsetDp: saved.horizontalOffsetDp,
      savedAppearanceOverrides: [...saved.appearanceOverrides],
      savedScales: saved.scales,
      savedVerticalOffsetDp: saved.verticalOffsetDp,
      savedDesign: saved.design,
      savedHalo: saved.halo,
      savedSpirit: saved.spirit,
      savedPersonaSide: saved.personaSide,
      savedOtherLayout: previousSaved,
      defaultVerticalOffsetDp: this.state.orientation === "portrait" ? 0 : 35,
    };
  }
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (command["method"] === "preview") {
      if (!sameOrientation(command as unknown as PhoneState, this.state))
        throw Error("Stale orientation");
      const preview = parsePreview({
        ...previewOf(initial()),
        icons: command["icons"],
        launcher: command["launcher"],
        connectionStyle: command["connectionStyle"],
        showPushToTalk: command["showPushToTalk"],
        sounds: command["sounds"],
        theme: command["theme"],
        mutedPresence: command["mutedPresence"],
        presenceScope: command["presenceScope"],
        mutedTuning: command["mutedTuning"],
        orientation: command["orientation"],
        orientationEpoch: command["orientationEpoch"],
        personaSide: command["personaSide"],
        connection: command["connection"],
        activity: command["activity"],
        spirit: command["spirit"],
        mode: command["mode"],
        scales: command["scales"],
        verticalOffsetDp: command["verticalOffsetDp"],
        horizontalOffsetDp: command["horizontalOffsetDp"],
        appearanceOverrides: command["appearanceOverrides"],
        design: command["design"],
        halo: command["halo"],
      });
      const merged = mergeAppearanceEdit(
        previewOf(this.state),
        preview,
        this.state.sharedAppearance,
        this.state.otherLayout,
      );
      merged.otherLayout.design.spacing = { ...preview.design.spacing };
      this.state = {
        ...this.state,
        ...merged.preview,
        sharedAppearance: merged.sharedAppearance,
        otherLayout: merged.otherLayout,
        remainingLayouts: Object.fromEntries(
          Object.entries(this.state.remainingLayouts).map(([key, layout]) => [
            key,
            { ...layout, design: { ...layout.design, spacing: { ...preview.design.spacing } } },
          ]),
        ) as PhoneState["remainingLayouts"],
        revision: this.state.revision + 1,
      };
    }
    if (command["method"] === "save") {
      if (!sameOrientation(command as unknown as PhoneState, this.state))
        throw Error("Stale orientation");
      if (this.refuseSave) throw Error("Save failed on phone");
      if (command["revision"] !== this.state.revision) throw Error("Stale revision");
      this.state = {
        ...this.state,
        savedSounds: { ...this.state.sounds },
        savedAppearance: visualSettingsOf(this.state),
        savedHorizontalOffsetDp: this.state.horizontalOffsetDp,
        savedAppearanceOverrides: [...this.state.appearanceOverrides],
        savedSharedAppearance: structuredClone(this.state.sharedAppearance),
        savedPersonaSide: this.state.personaSide,
        savedOtherLayout: layoutOf(this.state.otherLayout),
        savedScales: { ...this.state.scales },
        savedVerticalOffsetDp: this.state.verticalOffsetDp,
        savedDesign: structuredClone(this.state.design),
        savedHalo: structuredClone(this.state.halo),
        savedSpirit: { ...this.state.spirit },
      };
      const receipt = completeProfile(this.state);
      if (this.wrongConnectionStyleReceipt)
        receipt.connectionStyle = receipt.connectionStyle === "datum" ? "beacon" : "datum";
      if (this.wrongHiddenExtentReceipt) receipt.landscape.design.controlsWithoutPttDp++;
      if (this.wrongSoundsReceipt === "family") receipt.sounds.family = "rocker-13";
      if (this.wrongSoundsReceipt === "volumePercent") receipt.sounds.volumePercent++;
      if (this.changeSoundsDuringSave) this.state.sounds = { family: "off", volumePercent: 0 };
      if (this.wrongSharedReceipt) receipt.sharedAppearance.glowPercent++;
      if (this.wrongOverrideReceipt) receipt.appearanceOverrides = [];
      if (this.wrongHorizontalReceipt) receipt.landscape.horizontalOffsetDp++;
      if (this.wrongSpacingReceipt) receipt.design.spacing[this.wrongSpacingReceipt]++;
      if (this.wrongOtherReceipt) receipt.landscape.verticalOffsetDp++;
      if (this.wrongSideReceipt) receipt.personaSide = "right";
      if (this.rotateDuringSave) this.rotate();
      if (this.wrongOffsetReceipt) receipt.verticalOffsetDp++;
      if (this.wrongDesignReceipt === "height") receipt.design.controlsHeightDp++;
      if (this.wrongDesignReceipt === "share") receipt.design.holdSharePercent++;
      if (this.wrongDesignReceipt === "mute") Object.assign(receipt.design, { mute: "keycaps" });
      if (this.wrongDesignReceipt === "hold") Object.assign(receipt.design, { hold: "trigger" });
      if (this.wrongDesignReceipt === "composition")
        Object.assign(receipt.design, { composition: "dock" });
      if (this.wrongTraceReceipt === "pattern") receipt.design.traces.pattern = "splayed";
      else if (this.wrongTraceReceipt) receipt.design.traces[this.wrongTraceReceipt]++;
      if (this.changeDuringSave) {
        this.state.design.traces.weightPercent = 181;
        this.state.design.traces.personaSpacingPercent = 180;
        this.state.design.traces.footSpacingPercent = 190;
      }
      if (this.wrongHaloReceipt === "variant") receipt.halo.variant = "contained";
      else if (this.wrongHaloReceipt === "color") receipt.halo.colors.idle = "#ffffff";
      else if (this.wrongHaloReceipt) receipt.halo[this.wrongHaloReceipt]++;
      if (this.wrongSpiritReceipt === "surface")
        receipt.spirit.surface = receipt.spirit.surface === "still" ? "soft" : "still";
      if (this.wrongSpiritReceipt === "strengthPercent")
        receipt.spirit.strengthPercent = (receipt.spirit.strengthPercent + 1) % 101;
      if (this.wrongSpiritReceipt === "persona")
        receipt.spirit.persona = receipt.spirit.persona === "fixed" ? "follow" : "fixed";
      return {
        state: this.state,
        profile: JSON.stringify(
          this.oldReceipt
            ? { ...receipt, version: 9, design: versionNineDesign(receipt.design) }
            : receipt,
          null,
          2,
        ),
      };
    }
    return { state: this.state };
  }
}

async function fixture(options: { saveTo?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-configurator-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const phone = new FakePhone();
  const saveTo = options.saveTo ?? join(directory, "profiles", "choice.json");
  const { server, url } = await serveConfigurator(phone, { port: 0, device: "Test phone", saveTo });
  cleanups.push(() => server.stop(true));
  const origin = new URL(url).origin;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...headers },
      body: JSON.stringify({
        generation: phone.generation,
        orientation: phone.state.orientation,
        orientationEpoch: phone.state.orientationEpoch,
        ...(path === "preview"
          ? {
              icons: phone.state.icons,
              launcher: phone.state.launcher,
              connectionStyle: phone.state.connectionStyle,
              showPushToTalk: phone.state.showPushToTalk,
              sounds: phone.state.sounds,
              theme: phone.state.theme,
              mutedPresence: phone.state.mutedPresence,
              presenceScope: phone.state.presenceScope,
              mutedTuning: phone.state.mutedTuning,
              personaSide: phone.state.personaSide,
              connection: phone.state.connection,
              activity: phone.state.activity,
              spirit: phone.state.spirit,
              verticalOffsetDp: phone.state.verticalOffsetDp,
              horizontalOffsetDp: phone.state.horizontalOffsetDp,
              appearanceOverrides: phone.state.appearanceOverrides,
              design: phone.state.design,
              halo: phone.state.halo,
            }
          : {}),
        ...(body as object),
      }),
    });
  return { phone, saveTo, url, origin, post };
}

test("CLI opens a picker without a serial and isolates custom exports", () => {
  expect(parseArgs([]).device).toBe("");
  expect(() => parseArgs(["--save-to", "/tmp/export.json"])).toThrow("--device");
  expect(() => parseArgs(["--device", "phone", "--port", "65536"])).toThrow();
  expect(() => parseArgs(["--device", "phone", "--device", "other"])).toThrow();
  expect(parseArgs(["--device", "phone", "--port", "0"]).port).toBe(0);
});

test("Thinking audition shares Idle tuning without adding unsaved design fields", () => {
  const state = initial();
  const thinking = parsePreview({ ...previewOf(state), mode: "thinking" });
  expect(thinking.mode).toBe("thinking");
  expect(thinking.scales).toEqual(state.scales);
  expect(thinking.halo).toEqual(state.halo);
  const changed = { ...thinking, scales: { ...thinking.scales, idle: 65 } };
  const reset = resetPreview(changed, state, "size");
  expect(reset.mode).toBe("thinking");
  expect(reset.scales.idle).toBe(state.defaults.idle);
  expect(Object.keys(reset.scales).sort()).toEqual(["idle", "listening", "speaking"]);
  expect(() => parseScales({ ...state.scales, thinking: 65 })).toThrow();
});

test("preview protocol rejects out of range, fractional, unknown, or non-finite values", () => {
  expect(parseState(initial()).scales).toEqual(defaults);
  expect(() => parseScales({ ...defaults, listening: 121 })).toThrow();
  expect(() => parseScales({ ...defaults, listening: 58.5 })).toThrow();
  expect(() => parseScales({ ...defaults, listening: "58" })).toThrow();
  expect(() => parseScales({ ...defaults, listening: NaN })).toThrow();
  expect(() => parseScales({ ...defaults, offset: 35 })).toThrow();
  expect(() =>
    parsePreview({
      ...previewOf(initial()),
      connection: "connected",
      mode: "dreaming",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
      halo: defaultHalo(),
    }),
  ).toThrow();
  const saved = profile(initial());
  expectLegacyProfile(parseProfile(JSON.stringify(saved)), saved);
  for (const disconnectedArtboardScale of [1.5, 1.9] as const) {
    const receipt = { ...saved, disconnectedArtboardScale };
    expectLegacyProfile(parseProfile(JSON.stringify(receipt)), receipt);
  }
  for (const disconnectedArtboardScale of [1.6, "1.9", null])
    expect(() => parseProfile(JSON.stringify({ ...saved, disconnectedArtboardScale }))).toThrow();
  for (const verticalOffsetDp of [-200, 0, 20, 200]) {
    expect(parseProfile(JSON.stringify({ ...saved, verticalOffsetDp })).verticalOffsetDp).toBe(
      verticalOffsetDp,
    );
  }
  for (const verticalOffsetDp of [-201, 201, 20.5, "35", null, undefined]) {
    expect(() =>
      parsePreview({
        ...previewOf(initial()),
        connection: "connected",
        mode: "idle",
        scales: defaults,
        verticalOffsetDp,
        design: defaultDesign,
        halo: defaultHalo(),
      }),
    ).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, verticalOffsetDp }))).toThrow();
  }
});

function versionFourteen<
  T extends {
    horizontalOffsetDp: number;
    appearanceOverrides: unknown;
    sharedAppearance?: unknown;
    sounds?: unknown;
  },
>(value: T) {
  const {
    horizontalOffsetDp: _x,
    appearanceOverrides: _o,
    sharedAppearance: _s,
    sounds: _sounds,
    ...previous
  } = value;
  return previous;
}
function versionSeventeenDesign(design = defaultDesign) {
  const { controlsWithoutPttDp: _, ...previous } = structuredClone(design);
  return previous;
}
function versionSixteenDesign(design = defaultDesign) {
  return { ...versionSeventeenDesign(design), traces: { ...design.traces, offshootPercent: 0 } };
}
function versionThirteenTraces(traces = defaultTraces()) {
  const { reachDp: _, fadeLengthDp: _fade, tipOpacityPercent: _tip, ...previous } = traces;
  return { ...previous, offshootPercent: 0 };
}
function versionThirteenDesign(design = defaultDesign) {
  return { ...versionSeventeenDesign(design), traces: versionThirteenTraces(design.traces) };
}
function versionTwelveDesign(design = defaultDesign) {
  const { paddingDp: _, ...spacing } = design.spacing;
  return { ...versionThirteenDesign(design), spacing };
}
function versionTenDesign(design = defaultDesign) {
  const { spacing: _, ...previous } = versionThirteenDesign(design);
  return previous;
}
function versionNineDesign(design = defaultDesign) {
  const {
    personaSpacingPercent: _personaSpacing,
    footSpacingPercent: _footSpacing,
    ...traces
  } = versionThirteenTraces(design.traces);
  return { ...versionTenDesign(design), traces };
}

function previousDesign(design = defaultDesign) {
  const { traces: _traces, ...previous } = versionTenDesign(design);
  return previous;
}

test("current design requires Rockers and old profiles remain readable without rewriting", () => {
  expect(parseDesign(defaultDesign)).toEqual(defaultDesign);
  for (const composition of ["open", "dock", "yoke", "socket"])
    expect(() => parseDesign({ ...defaultDesign, composition })).toThrow();
  expect(() => parseDesign({ ...defaultDesign, header: "remote-content" })).toThrow();
  for (const retired of [
    { header: "drawer" },
    { hold: "beam" },
    { hold: "trigger" },
    { mute: "keycaps" },
    { mute: "glyphs" },
    { layout: "original" },
  ])
    expect(() => parseDesign({ ...defaultDesign, ...retired })).toThrow();
  expect(() => parseDesign({ ...defaultDesign, asset: "/arbitrary" })).toThrow();
  const { design: _, halo: _halo, spirit: _spirit, ...legacy } = profile(initial());
  const old = { ...legacy, version: 2 as const };
  expectLegacyProfile(parseProfile(JSON.stringify(old)), old);
  expect(profileHalo(parseProfile(JSON.stringify(old)))).toEqual(defaultHalo());
  const v3 = {
    ...legacy,
    version: 3 as const,
    design: { layout: "studio", header: "drawer", mute: "keycaps", hold: "trigger" },
  };
  expect(parseProfile(JSON.stringify(v3))).toEqual(v3 as Profile);
  expect(profileDesign(parseProfile(JSON.stringify(v3)))).toEqual({
    ...defaultDesign,
    spacing: legacySpacing(),
  });
  const { composition: _composition, ...previous } = previousDesign();
  const v4 = { ...legacy, version: 4 as const, design: { ...previous, hold: "trigger" as const } };
  expect(parseProfile(JSON.stringify(v4))).toEqual(v4);
  expect(profileHalo(parseProfile(JSON.stringify(v4)))).toEqual(defaultHalo());
  expect(() => parseProfile(JSON.stringify({ ...v4, version: 5 }))).toThrow();
  const v5 = withoutThinkingWingspan({
    ...v4,
    version: 5 as const,
    halo: { ...defaultHalo(), variant: "contained" as const, containedSizePercent: 83 },
  });
  expectLegacyProfile(parseProfile(JSON.stringify(v5)), v5);
  expect(profileDesign(parseProfile(JSON.stringify(v5)))).toEqual({
    ...defaultDesign,
    spacing: legacySpacing(),
  });
  expect(withoutThinkingWingspan(profileHalo(parseProfile(JSON.stringify(v5))))).toEqual(v5.halo);
  for (const saved of [v4, v5]) {
    expect(() =>
      parseProfile(JSON.stringify({ ...saved, design: { ...saved.design, hold: "rocker" } })),
    ).toThrow();
    expect(() =>
      parseProfile(JSON.stringify({ ...saved, design: { ...saved.design, composition: "dock" } })),
    ).toThrow();
  }
});

test("every legacy button choice migrates to Rockers while retaining other choices and reset scopes", () => {
  const latest = profile(initial());
  const { design: _design, halo: _halo, spirit: _spirit, ...base } = latest;
  const halo = withoutThinkingWingspan({
    ...defaultHalo(),
    variant: "contained" as const,
    containedSizePercent: 93,
  });
  const spirit = { surface: "soft", strengthPercent: 77, persona: "follow" } as const;
  const candidates: unknown[] = [{ ...base, version: 2 }];
  for (const layout of ["original", "studio"])
    for (const header of ["quiet", "drawer", "none"])
      for (const mute of ["glyphs", "rockers", "keycaps"])
        for (const hold of ["beam", "trigger", "keycap"])
          candidates.push({ ...base, version: 3, design: { layout, header, mute, hold } });
  for (const version of [4, 5, 6, 7, 8])
    for (const mute of version === 8 ? ["rockers"] : ["rockers", "keycaps"])
      for (const hold of version === 8
        ? ["rocker"]
        : version < 6
          ? ["trigger"]
          : ["trigger", "rocker"])
        for (const composition of version < 6
          ? [undefined]
          : version === 6
            ? ["open", "dock", "yoke"]
            : ["open", "dock", "yoke", "socket", "traces"])
          candidates.push({
            ...base,
            version,
            verticalOffsetDp: -72,
            scaleMultipliers: { speaking: 0.83, listening: 0.52, idle: 0.91 },
            design: {
              layout: "studio",
              header: "none",
              mute,
              hold,
              ...(composition ? { composition } : {}),
              controlsHeightDp: 371,
              holdSharePercent: 53.7,
            },
            ...(version >= 5 ? { halo } : {}),
            ...(version >= 7 ? { spirit } : {}),
          });
  for (const candidate of candidates) {
    const encoded = JSON.stringify(candidate);
    const loaded = parseProfile(encoded);
    const design = profileDesign(loaded);
    expect(design.mute).toBe("rockers");
    expect(design.hold).toBe("rocker");
    if (loaded.version !== 2 && loaded.version !== 3) {
      expect(design).toEqual({
        ...loaded.design,
        controlsWithoutPttDp: loaded.design.controlsHeightDp,
        composition: "traces",
        traces: defaultTraces(),
        spacing: legacySpacing(),
        mute: "rockers",
        hold: "rocker",
      });
      expect(loaded.verticalOffsetDp).toBe(-72);
      expect(loaded.scaleMultipliers).toEqual({ speaking: 0.83, listening: 0.52, idle: 0.91 });
    } else expect(design).toEqual({ ...defaultDesign, spacing: legacySpacing() });
    expect(profileHalo(loaded)).toEqual(
      loaded.version >= 5 ? { ...halo, thinkingWingspan: 2 } : defaultHalo(),
    );
    expect(profileSpirit(loaded)).toEqual(loaded.version >= 7 ? spirit : defaultSpirit());
    const current = {
      ...previewOf(initial()),
      design,
      halo: profileHalo(loaded),
      spirit: profileSpirit(loaded),
      activity: "voice" as const,
      verticalOffsetDp: loaded.verticalOffsetDp,
    };
    expect(resetPreview(current, initial(), "controls")).toEqual({
      ...current,
      design: {
        ...design,
        controlsHeightDp: defaultDesign.controlsHeightDp,
        holdSharePercent: defaultDesign.holdSharePercent,
      },
    });
    expect(resetPreview(current, initial(), "position")).toEqual({
      ...current,
      verticalOffsetDp: 35,
    });
    expect(JSON.stringify(withoutThinkingWingspan(loaded))).toBe(encoded);
  }
});

test("current previews, states and version 10 profiles reject retired styles before dispatch", async () => {
  const { phone, post } = await fixture();
  for (const change of [
    { mute: "keycaps" },
    { hold: "trigger" },
    { mute: "glyphs" },
    { hold: "beam" },
  ]) {
    const design = { ...defaultDesign, ...change };
    expect(() => parseProfile(JSON.stringify({ ...profile(initial()), design }))).toThrow();
    for (const field of ["design", "savedDesign", "defaultDesign"])
      expect(() => parseState({ ...initial(), [field]: design })).toThrow();
    expect((await post("preview", { mode: "idle", scales: defaults, design })).status).toBe(400);
  }
  expect(() => parseState({ ...initial(), protocol: 7 })).toThrow();
  expect(phone.calls).toHaveLength(0);
});

test("trace settings have exact fields, routes and integer bounds at every current boundary", async () => {
  expect(traceBounds).toEqual({
    stancePercent: [75, 150],
    personaSpacingPercent: [50, 200],
    footSpacingPercent: [50, 200],
    weightPercent: [50, 250],

    glowPercent: [0, 100],
    reachDp: [-40, 120],
    fadeLengthDp: [0, 80],
    tipOpacityPercent: [0, 100],
  });
  const traces = defaultTraces();
  expect(traces).toEqual({
    pattern: "parallel",
    stancePercent: 100,
    personaSpacingPercent: 100,
    footSpacingPercent: 100,
    weightPercent: 100,

    glowPercent: 0,
    reachDp: 0,
    fadeLengthDp: 12,
    tipOpacityPercent: 0,
  });
  for (const pattern of tracePatterns)
    expect(parseTraces({ ...traces, pattern }).pattern).toBe(pattern);
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...traces, pattern: "open" },
    { ...traces, extra: 1 },
  ];
  for (const field of traceAmountFields) {
    const [min, max] = traceBounds[field];
    for (const value of [min, max])
      expect(parseTraces({ ...traces, [field]: value })[field]).toBe(value);
    for (const value of [min - 1, max + 1, min + 0.5, "100", null, undefined, NaN, Infinity])
      invalid.push({ ...traces, [field]: value });
  }
  const { phone, post } = await fixture();
  for (const traces of invalid) {
    const design = { ...defaultDesign, traces };
    expect(() => parseTraces(traces)).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...currentProfile(initial()), design }))).toThrow();
    for (const field of ["design", "savedDesign", "defaultDesign"])
      expect(() => parseState({ ...initial(), [field]: design })).toThrow();
    expect((await post("preview", { mode: "idle", scales: defaults, design })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
  const old = { ...profile(initial()), version: 8 as const, design: previousDesign() };
  expectLegacyProfile(parseProfile(JSON.stringify(old)), old);
  for (const design of [
    { ...old.design, traces },
    { ...old.design, mute: "keycaps" },
    { ...old.design, hold: "trigger" },
  ])
    expect(() => parseProfile(JSON.stringify({ ...old, design }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...old, version: 9 }))).toThrow();
  expect(() => parseState({ ...initial(), protocol: 8 })).toThrow();
});

test("version 9 profiles retain every previous trace value and add only baseline spacing in memory", () => {
  for (const pattern of tracePatterns) {
    const previous = withoutThinkingWingspan({
      ...profile(initial()),
      version: 9 as const,
      scaleMultipliers: { speaking: 0.92, listening: 0.47, idle: 0.83 },
      verticalOffsetDp: -67,
      design: {
        ...versionNineDesign(),
        controlsHeightDp: 374,
        holdSharePercent: 57.3,
        traces: {
          pattern,
          stancePercent: 123,
          weightPercent: 211,
          offshootPercent: 76,
          glowPercent: 43,
        },
      },
      halo: { ...defaultHalo(), variant: "contained" as const, containedSizePercent: 92 },
      spirit: { surface: "soft", strengthPercent: 67, persona: "follow" } as const,
    });
    const encoded = JSON.stringify(previous);
    const loaded = parseProfile(encoded);
    expectLegacyProfile(loaded, previous);
    const migrated = profileDesign(loaded);
    expect(migrated).toEqual({
      ...previous.design,
      controlsWithoutPttDp: previous.design.controlsHeightDp,
      spacing: legacySpacing(),
      traces: migrateTraces(previous.design.traces),
    });
    expect(withoutThinkingWingspan(profileHalo(loaded))).toEqual(previous.halo);
    expect(profileSpirit(loaded)).toEqual(previous.spirit);
    migrated.traces.stancePercent = 150;
    migrated.traces.personaSpacingPercent = 200;
    expect(JSON.stringify(withoutThinkingWingspan(loaded))).toBe(encoded);
    for (const field of ["personaSpacingPercent", "footSpacingPercent"]) {
      const traces = { ...previous.design.traces, [field]: 100 };
      expect(() =>
        parseProfile(JSON.stringify({ ...previous, design: { ...previous.design, traces } })),
      ).toThrow();
      expect(() =>
        parseProfile(
          JSON.stringify({ ...previous, version: 10, design: { ...previous.design, traces } }),
        ),
      ).toThrow();
    }
    expect(() => parseProfile(JSON.stringify({ ...previous, version: 10 }))).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({ ...previous, design: { ...previous.design, traces: defaultTraces() } }),
      ),
    ).toThrow();
  }
  expect(() => parseState({ ...initial(), protocol: 9 })).toThrow();
});

test("Persona and button spacing edits remain independent from each other and stance", async () => {
  const { phone, post, saveTo } = await fixture();
  const selection = previewOf(initial());
  selection.design.traces.stancePercent = 127;
  selection.design.traces.personaSpacingPercent = 173;
  expect((await post("preview", selection)).status).toBe(200);
  expect(phone.state.design.traces).toEqual({
    ...defaultTraces(),
    stancePercent: 127,
    personaSpacingPercent: 173,
  });
  selection.design.traces.footSpacingPercent = 68;
  expect((await post("preview", selection)).status).toBe(200);
  expect(phone.state.design.traces).toEqual({
    ...defaultTraces(),
    stancePercent: 127,
    personaSpacingPercent: 173,
    footSpacingPercent: 68,
  });
  selection.design.traces.stancePercent = 91;
  expect((await post("preview", selection)).status).toBe(200);
  expect(phone.state.design.traces).toEqual({
    ...defaultTraces(),
    stancePercent: 91,
    personaSpacingPercent: 173,
    footSpacingPercent: 68,
  });
  expect(phone.state.savedDesign.traces).toEqual(defaultTraces());
  expect(phone.state.scales).toEqual(defaults);
  expect(phone.state.halo).toEqual(defaultHalo());
  expect(phone.state.spirit).toEqual(defaultSpirit());
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("every nested trace receipt must match before an existing host profile can be replaced", async () => {
  for (const field of ["pattern", ...traceAmountFields] as const) {
    const { phone, post, saveTo } = await fixture();
    expect((await post("save", { revision: 0 })).status).toBe(200);
    const original = await readFile(saveTo, "utf8");
    phone.wrongTraceReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await readFile(saveTo, "utf8")).toBe(original);
  }
});

test("trace edits remain unsaved and exact version 18 Save snapshots the reviewed nested settings", async () => {
  const { phone, post, saveTo } = await fixture();
  const traces: TraceSelection = {
    ...defaultTraces(),
    pattern: "circuit",
    stancePercent: 136,
    personaSpacingPercent: 83,
    footSpacingPercent: 158,
    weightPercent: 170,

    glowPercent: 28,
  };
  expect(
    (
      await post("preview", {
        mode: "idle",
        scales: defaults,
        design: { ...defaultDesign, traces },
      })
    ).status,
  ).toBe(200);
  expect(phone.state.design.traces).toEqual(traces);
  expect(phone.state.savedDesign.traces).toEqual(defaultTraces());
  expect(await Bun.file(saveTo).exists()).toBe(false);
  phone.changeDuringSave = true;
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileDesign(saved).traces).toEqual(traces);
  expect(phone.state.savedDesign.traces).toEqual(traces);
  expect(phone.state.design.traces.weightPercent).toBe(181);
  expect(phone.state.design.traces.personaSpacingPercent).toBe(180);
  expect(phone.state.design.traces.footSpacingPercent).toBe(190);
});

test("trace and glow resets isolate their scopes and all previous resets preserve nested tuning", () => {
  const phone = initial();
  const current = previewOf(phone);
  current.design.traces = {
    ...defaultTraces(),
    pattern: "splayed",
    stancePercent: 134,
    personaSpacingPercent: 77,
    footSpacingPercent: 192,
    weightPercent: 181,

    glowPercent: 37,
  };
  current.halo.variant = "contained";
  current.spirit = { surface: "soft", strengthPercent: 62, persona: "follow" };
  const before = structuredClone(current);
  for (const target of [
    "controls",
    "size",
    "position",
    "animation",
    "colors",
    "light",
    "spirit-colors",
  ] as const)
    expect(resetPreview(current, phone, target).design.traces).toEqual(current.design.traces);
  expect(resetPreview(current, phone, "traces")).toEqual({
    ...current,
    design: { ...current.design, traces: { ...phone.defaultDesign.traces, glowPercent: 37 } },
  });
  expect(resetPreview(current, phone, "glow")).toEqual({
    ...current,
    design: { ...current.design, traces: { ...current.design.traces, glowPercent: 0 } },
  });
  const copied = previewOf(current);
  copied.design.traces.weightPercent = 200;
  const reset = resetPreview(current, phone, "glow");
  reset.design.traces.pattern = "circuit";
  const saved = profile({ ...phone, ...current });
  const migrated = profileDesign(saved);
  migrated.traces.stancePercent = 150;
  expect(current).toEqual(before);
  expect(saved.design.traces).toEqual(versionThirteenTraces(before.design.traces));
  expect(phone).toEqual(initial());
});

test("control dimensions and connection scenarios are bounded", () => {
  for (const controlsHeightDp of [240, 262, 480])
    for (const holdSharePercent of [30, defaultDesign.holdSharePercent, 60])
      expect(
        parseDesign({ ...defaultDesign, controlsHeightDp, holdSharePercent }).controlsHeightDp,
      ).toBe(controlsHeightDp);
  for (const controlsHeightDp of [159, 1601, 300.5, "262", null, Infinity])
    expect(() => parseDesign({ ...defaultDesign, controlsHeightDp })).toThrow();
  for (const holdSharePercent of [29.9, 60.1, "44", null, NaN, Infinity])
    expect(() => parseDesign({ ...defaultDesign, holdSharePercent })).toThrow();
  expect(() =>
    parsePreview({
      ...previewOf(initial()),
      connection: "reconnect-call",
      mode: "idle",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
      halo: defaultHalo(),
    }),
  ).toThrow();
});

test("resizing controls preserves Persona tuning and only explicit Save keeps the design", async () => {
  const { phone, post, saveTo } = await fixture();
  const design = {
    ...defaultDesign,
    mute: "rockers" as const,
    hold: "rocker" as const,
    composition: "traces" as const,
    controlsHeightDp: 380,
    holdSharePercent: 54.3,
  };
  const preview = {
    connection: "connecting",
    mode: "idle",
    scales: { ...defaults, speaking: 48 },
    verticalOffsetDp: -24,
    design,
  };
  expect((await post("preview", preview)).status).toBe(200);
  expect(phone.state.design).toEqual(design);
  expect(phone.state.scales).toEqual(preview.scales);
  expect(phone.state.savedDesign).toEqual(defaultDesign);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  expect(parseProfile(await readFile(saveTo, "utf8")).design).toEqual(design);
  expect(phone.state.savedDesign).toEqual(design);
});

test("a different design in the phone receipt is refused before writing the host copy", async () => {
  for (const field of ["height", "share", "mute", "hold", "composition"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongDesignReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("browser updates one state and saves the exact phone receipt privately on host", async () => {
  const { phone, post, saveTo, url } = await fixture();
  expect((await (await fetch(new URL("state", url))).json()).state.scales).toEqual(defaults);
  expect(
    (
      await post("preview", {
        mode: "listening",
        scales: { ...defaults, listening: 52 },
        verticalOffsetDp: -24,
      })
    ).status,
  ).toBe(200);
  expect(phone.state.scales).toEqual({ ...defaults, listening: 52 });
  expect(phone.state.verticalOffsetDp).toBe(-24);
  expect(phone.state.savedVerticalOffsetDp).toBe(35);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  const response = await post("save", { revision: phone.state.revision });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.hostSaved.scaleMultipliers.listening).toBe(0.52);
  expect(saved.hostSaved.verticalOffsetDp).toBe(-24);
  expect(await readFile(saveTo, "utf8")).toBe(
    JSON.stringify(completeProfile(phone.state), null, 2),
  );
  expect((await stat(saveTo)).mode & 0o777).toBe(0o600);
  expect(phone.state.savedScales).toEqual(phone.state.scales);
  expect(phone.state.savedVerticalOffsetDp).toBe(-24);
});

test("a mismatched position receipt never claims a saved host copy", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.wrongOffsetReceipt = true;
  const response = await post("save", { revision: 0 });
  expect(response.status).toBe(502);
  expect((await response.json()).error).toContain("different settings");
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("invalid origins, hosts, routes, bodies and stale saves never mutate the phone", async () => {
  const { phone, post, url, origin } = await fixture();
  expect(url).toBe(`${origin}/`);
  expect((await fetch(`${origin}/state`)).status).toBe(200);
  expect((await fetch(`${origin}/old-token/state`)).status).toBe(404);
  expect((await fetch(url, { headers: { Host: "attacker.invalid" } })).status).toBe(404);
  expect(
    (
      await post(
        "preview",
        { mode: "idle", scales: defaults },
        { Origin: "https://attacker.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post("preview", { mode: "idle", scales: { ...defaults, listening: 900 } })).status,
  ).toBe(400);
  expect((await post("save", { revision: 40 })).status).toBe(409);
  expect((await post("save", { revision: 0, path: "/arbitrary" })).status).toBe(400);
  expect((await fetch(new URL("state", url), { method: "OPTIONS" })).status).toBe(405);
  expect(phone.calls).toHaveLength(0);
  const page = await fetch(url);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await fetch(new URL("type.ttf", url))).status).toBe(200);
});

test("save refusal and phone loss never claim a saved host copy", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.refuseSave = true;
  expect((await post("save", { revision: 0 })).status).toBe(502);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  phone.connected = false;
  expect((await post("preview", { mode: "idle", scales: defaults })).status).toBe(503);
  expect(phone.calls).toHaveLength(1);
});

test("a host file failure reports that the phone saved but the host did not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-save-directory-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { phone, post } = await fixture({ saveTo: directory });
  const response = await post("save", { revision: 0 });
  expect(response.status).toBe(500);
  expect((await response.json()).error).toContain("Saved on the phone, but");
  expect(phone.calls[0]?.["method"]).toBe("save");
});

test("a returned phone rejects browser edits and saves from the previous connection", async () => {
  const { phone, post, saveTo, url } = await fixture();
  phone.connected = false;
  expect((await (await fetch(new URL("state", url))).json()).connected).toBe(false);
  phone.generation = 2;
  phone.connected = true;
  expect((await post("preview", { generation: 1, mode: "idle", scales: defaults })).status).toBe(
    409,
  );
  expect((await post("save", { generation: 1, revision: 0 })).status).toBe(409);
  expect((await post("preview", { generation: null, mode: "idle", scales: defaults })).status).toBe(
    400,
  );
  expect(phone.calls).toHaveLength(0);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  const state = await (await fetch(new URL("state", url))).json();
  expect(state.generation).toBe(2);
  expect(state.connected).toBe(true);
  expect(
    (await post("preview", { generation: state.generation, mode: "idle", scales: defaults }))
      .status,
  ).toBe(200);
});

async function wire() {
  let peer!: Socket;
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const server = createServer((socket) => {
    peer = socket;
    accept();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  const phone = new PhoneConnection(socket, "preview-test-token");
  await accepted;
  cleanups.push(() => {
    phone.close();
    peer.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { peer, phone };
}

test("device connection correlates split replies and fails pending work on disconnect", async () => {
  const { peer, phone } = await wire();
  const response = phone.request({ method: "get" });
  const frame = JSON.stringify({ id: 1, state: initial() });
  peer.write(frame.slice(0, 25));
  peer.write(`${frame.slice(25)}\n`);
  expect((await response).state.scales).toEqual(defaults);
  const pending = phone.request({ method: "save", revision: 0 });
  peer.destroy();
  await expect(pending).rejects.toThrow("disconnected");
  expect(phone.connected).toBe(false);
});

test("oversized or unrelated device replies cannot update the preview", async () => {
  const { peer, phone } = await wire();
  const pending = phone.request({ method: "get" });
  peer.write("x".repeat(16384));
  await expect(pending).rejects.toThrow("disconnected");
  expect(phone.state).toBeUndefined();
  const next = await wire();
  const requested = next.phone.request({ method: "get" });
  next.peer.write(`${JSON.stringify({ id: 99, state: initial() })}\n`);
  await expect(requested).rejects.toThrow("disconnected");
  expect(next.phone.state).toBeUndefined();
});

test("Halo tuning bounds every field and accepts only opaque RGB colors", () => {
  const base = defaultHalo();
  expect(parseHalo(base)).toEqual(base);
  for (const key of haloMotionFields) {
    for (const value of [0, 100]) expect(parseHalo({ ...base, [key]: value })[key]).toBe(value);
    for (const value of [-1, 101, 25.5, "25", null, NaN, Infinity])
      expect(() => parseHalo({ ...base, [key]: value })).toThrow();
  }
  for (const value of [34, 121, 78.5, "78", null])
    expect(() => parseHalo({ ...base, containedSizePercent: value })).toThrow();
  expect(() => parseHalo({ ...base, variant: "remote" })).toThrow();
  expect(() => parseHalo({ ...base, asset: "/arbitrary" })).toThrow();
  for (const value of ["red", "#fff", "#ffffff80", "url(test)", "#zzzzzz", 0, null])
    expect(() => parseHalo({ ...base, colors: { ...base.colors, idle: value } })).toThrow();
  expect(parseHalo({ ...base, colors: { ...base.colors, idle: "#ABCDEF" } }).colors.idle).toBe(
    "#abcdef",
  );
  expect(() => parseHalo({ ...base, colors: { ...base.colors, extra: "#000000" } })).toThrow();
});

test("Thinking wingspan is strict in protocol30 and profile23 while profile22 gains two in memory", () => {
  const base = defaultHalo();
  expect(thinkingWingspanBounds).toEqual({ min: 1, max: 10, default: 2 });
  for (const thinkingWingspan of [1, 2, 10])
    expect(parseHalo({ ...base, thinkingWingspan }).thinkingWingspan).toBe(thinkingWingspan);
  for (const thinkingWingspan of [0, 11, 2.5, "2", null, undefined, NaN, Infinity])
    expect(() => parseHalo({ ...base, thinkingWingspan })).toThrow();
  const missing = { ...base } as Record<string, unknown>;
  delete missing["thinkingWingspan"];
  expect(() => parseHalo(missing)).toThrow();
  expect(() => parseHalo({ ...base, futureWingspan: 3 })).toThrow();
  const untouchedState = initial();
  const untouchedStateText = JSON.stringify(untouchedState);
  parseState(untouchedState);
  expect(JSON.stringify(untouchedState)).toBe(untouchedStateText);

  const stateMutations: Array<(state: PhoneState) => void> = [
    (state) => delete (state.halo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (state) => delete (state.savedHalo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (state) => delete (state.defaultHalo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (state) =>
      delete (state.sharedAppearance.halo as unknown as Record<string, unknown>)[
        "thinkingWingspan"
      ],
    (state) =>
      delete (state.otherLayout.halo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (state) => {
      if (!("portraitReverse" in state.remainingLayouts))
        throw Error("Portrait state must carry reverse-orientation layouts");
      delete (state.remainingLayouts.portraitReverse.halo as unknown as Record<string, unknown>)[
        "thinkingWingspan"
      ];
    },
  ];
  for (const mutate of stateMutations) {
    const state = initial();
    mutate(state);
    expect(() => parseState(state)).toThrow();
  }

  const current = completeProfile(initial());
  const profileMutations: Array<(profile: Extract<Profile, { version: 23 }>) => void> = [
    (profile) => delete (profile.halo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (profile) =>
      delete (profile.sharedAppearance.halo as unknown as Record<string, unknown>)[
        "thinkingWingspan"
      ],
    (profile) =>
      delete (profile.landscape.halo as unknown as Record<string, unknown>)["thinkingWingspan"],
    (profile) =>
      delete (profile.portraitReverse.halo as unknown as Record<string, unknown>)[
        "thinkingWingspan"
      ],
    (profile) =>
      delete (profile.landscapeReverse.halo as unknown as Record<string, unknown>)[
        "thinkingWingspan"
      ],
  ];
  for (const mutate of profileMutations) {
    const profile = structuredClone(current);
    mutate(profile);
    expect(() => parseProfile(JSON.stringify(profile))).toThrow();
  }

  const legacy = withoutThinkingWingspan({ ...current, version: 22 as const });
  const sourceText = JSON.stringify(legacy);
  const loaded = parseProfile(sourceText);
  expect(sourceText).toBe(JSON.stringify(legacy));
  for (const orientation of [
    "portrait",
    "landscape",
    "portrait-reverse",
    "landscape-reverse",
  ] as const)
    expect(profileLayout(loaded, orientation).halo.thinkingWingspan).toBe(2);
  expect(profileSharedAppearance(loaded).halo.thinkingWingspan).toBe(2);
  expect(() =>
    parseProfile(
      JSON.stringify({
        ...legacy,
        halo: { ...legacy.halo, thinkingWingspan: 2 },
      }),
    ),
  ).toThrow("Legacy Halo contains current fields");
});

test("Contained saves motion colors and common size without replacing Original sizes", async () => {
  const { phone, post, saveTo } = await fixture();
  const halo = {
    ...defaultHalo(),
    variant: "contained" as const,
    containedSizePercent: 83,
    thinkingWingspan: 7,
    ringSpreadPercent: 42,
    listeningPulsePercent: 12,
    speakingMotionPercent: 65,
    idleBreathingPercent: 0,
    colors: { speaking: "#ff82dd", listening: "#44efbb", idle: "#eeedcc" },
  };
  const scales = { speaking: 80, listening: 53, idle: 75 };
  expect((await post("preview", { mode: "listening", scales, halo })).status).toBe(200);
  expect(phone.state.halo).toEqual(halo);
  expect(phone.state.savedHalo).toEqual(defaultHalo());
  expect(
    (await post("preview", { mode: "idle", scales, halo: { ...halo, variant: "original" } }))
      .status,
  ).toBe(200);
  expect(phone.state.scales).toEqual(scales);
  expect(phone.state.halo.containedSizePercent).toBe(83);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileHalo(saved)).toEqual({ ...halo, variant: "original" });
  expect(phone.state.savedHalo).toEqual(phone.state.halo);
  expect("connection" in saved).toBe(false);
});

test("a mismatched Halo receipt cannot overwrite the host profile", async () => {
  for (const field of [
    "variant",
    "color",
    "containedSizePercent",
    "thinkingWingspan",
    ...haloMotionFields,
  ] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongHaloReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("granular resets preserve unrelated choices and do not mutate saved state", () => {
  const phone = initial();
  const selected = previewOf(phone);
  selected.mode = "listening";
  selected.design = {
    ...selected.design,
    mute: "rockers",
    hold: "rocker",
    composition: "traces",
    traces: {
      ...defaultTraces(),
      pattern: "circuit",
      stancePercent: 132,
      personaSpacingPercent: 169,
      footSpacingPercent: 58,
      weightPercent: 184,

      glowPercent: 35,
    },
    controlsHeightDp: 380,
    holdSharePercent: 55,
  };
  selected.scales = { speaking: 81, listening: 53, idle: 70 };
  selected.verticalOffsetDp = -24;
  selected.halo = {
    ...selected.halo,
    variant: "contained",
    containedSizePercent: 91,
    ringSpreadPercent: 82,
    listeningPulsePercent: 99,
    speakingMotionPercent: 73,
    idleBreathingPercent: 61,
    colors: { speaking: "#ff0000", listening: "#00ff00", idle: "#0000ff" },
  };
  selected.spirit = { surface: "soft", strengthPercent: 81, persona: "follow" };
  selected.activity = "voice";
  const before = structuredClone(selected);
  const saved = structuredClone(phone);
  const animation = resetPreview(selected, phone, "animation");
  expect(animation).toEqual({
    ...selected,
    halo: {
      ...selected.halo,
      ringSpreadPercent: 35,
      listeningPulsePercent: 25,
      speakingMotionPercent: 25,
      idleBreathingPercent: 25,
    },
  });
  expect(resetPreview(selected, phone, "colors")).toEqual({
    ...selected,
    halo: { ...selected.halo, colors: phone.defaultHalo.colors },
  });
  expect(resetPreview(selected, phone, "size")).toEqual({
    ...selected,
    halo: { ...selected.halo, containedSizePercent: 78 },
  });
  expect(resetPreview(selected, phone, "position")).toEqual({ ...selected, verticalOffsetDp: 35 });
  expect(resetPreview(selected, phone, "controls")).toEqual({
    ...selected,
    design: {
      ...selected.design,
      controlsHeightDp: 262,
      holdSharePercent: defaultDesign.holdSharePercent,
    },
  });
  expect(resetPreview(selected, phone, "light")).toEqual({
    ...selected,
    spirit: { ...selected.spirit, surface: "still", strengthPercent: 35 },
  });
  expect(resetPreview(selected, phone, "spirit-colors")).toEqual({
    ...selected,
    spirit: { ...selected.spirit, persona: "fixed" },
  });
  const original = { ...selected, halo: { ...selected.halo, variant: "original" as const } };
  expect(resetPreview(original, phone, "size")).toEqual({
    ...original,
    scales: { ...original.scales, listening: 58 },
  });
  expect(selected).toEqual(before);
  expect(phone).toEqual(saved);
});

test("spirit and activity validate exactly while Original retains its follow selection", () => {
  const base = defaultSpirit();
  expect(base).toEqual({ surface: "still", strengthPercent: 35, persona: "fixed" });
  for (const surface of ["still", "soft"] as const)
    for (const persona of ["fixed", "follow"] as const)
      for (const strengthPercent of [0, 35, 100])
        expect(parseSpirit({ surface, persona, strengthPercent })).toEqual({
          surface,
          persona,
          strengthPercent,
        });
  for (const strengthPercent of [-1, 101, 35.5, "35", null, undefined, NaN, Infinity])
    expect(() => parseSpirit({ ...base, strengthPercent })).toThrow();
  for (const change of [{ surface: "glow" }, { persona: "automatic" }, { asset: "remote" }])
    expect(() => parseSpirit({ ...base, ...change })).toThrow();
  expect(() => parseSpirit({ surface: "still", strengthPercent: 35 })).toThrow();
  const preview = previewOf(initial());
  for (const activity of ["steady", "voice"] as const) {
    const selected = parsePreview({ ...preview, activity, spirit: { ...base, persona: "follow" } });
    expect(selected.activity).toBe(activity);
    expect(selected.halo.variant).toBe("original");
    expect(previewOf(selected).spirit.persona).toBe("follow");
  }
  for (const activity of ["live", null, undefined]) {
    expect(() => parsePreview({ ...preview, activity })).toThrow();
    expect(() => parseState({ ...initial(), activity })).toThrow();
  }
  for (const field of ["spirit", "savedSpirit", "defaultSpirit"] as const)
    expect(() =>
      parseState({ ...initial(), [field]: { ...base, strengthPercent: 101 } }),
    ).toThrow();
});

test("old profile contracts keep exact fields and old compositions while spirit defaults in memory", () => {
  const { spirit: _spirit, ...latestWithoutSpirit } = profile(initial());
  const v6 = {
    ...latestWithoutSpirit,
    version: 6 as const,
    design: { ...previousDesign(), composition: "yoke" as const },
  };
  const encoded = JSON.stringify(v6);
  const decoded = parseProfile(encoded);
  expectLegacyProfile(decoded, v6);
  expect(JSON.stringify(withoutThinkingWingspan(decoded))).toBe(encoded);
  expect(profileSpirit(decoded)).toEqual(defaultSpirit());
  expect("spirit" in decoded).toBe(false);
  expect(profileDesign(decoded).composition).toBe("traces");
  for (const composition of ["socket", "traces"])
    expect(() =>
      parseProfile(JSON.stringify({ ...v6, design: { ...v6.design, composition } })),
    ).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...v6, spirit: defaultSpirit() }))).toThrow();
  const v7 = {
    ...v6,
    version: 7,
    spirit: defaultSpirit(),
    design: { ...v6.design, composition: "socket" },
  };
  expect(profileSpirit(parseProfile(JSON.stringify(v7)))).toEqual(defaultSpirit());
  expect(() => parseProfile(JSON.stringify({ ...v7, activity: "voice" }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...v7, spirit: undefined }))).toThrow();
});

test("spirit is unsaved until exact version 18 Save and activity never enters the profile", async () => {
  const { phone, post, saveTo } = await fixture();
  const spirit = { surface: "soft", strengthPercent: 72, persona: "follow" } as const;
  const design = { ...defaultDesign, composition: "traces" as const };
  expect(
    (
      await post("preview", {
        mode: "speaking",
        scales: defaults,
        activity: "voice",
        spirit,
        design,
      })
    ).status,
  ).toBe(200);
  expect(phone.state.spirit).toEqual(spirit);
  expect(phone.state.savedSpirit).toEqual(defaultSpirit());
  expect(phone.state.activity).toBe("voice");
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileSpirit(saved)).toEqual(spirit);
  expect(profileDesign(saved)).toEqual(design);
  expect(phone.state.savedSpirit).toEqual(spirit);
  expect("activity" in saved).toBe(false);
  expect("connection" in saved).toBe(false);
});

test("mismatched spirit or old-version receipts never publish a host copy", async () => {
  for (const field of ["surface", "strengthPercent", "persona"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongSpiritReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
  const { phone, post, saveTo } = await fixture();
  phone.oldReceipt = true;
  expect((await post("save", { revision: 0 })).status).toBe(502);
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("invalid activity or spirit never reaches the phone", async () => {
  const { phone, post } = await fixture();
  for (const change of [
    { activity: "live" },
    { spirit: { ...defaultSpirit(), strengthPercent: 101 } },
    { spirit: null },
  ])
    expect((await post("preview", { mode: "idle", scales: defaults, ...change })).status).toBe(400);
  expect(phone.calls).toHaveLength(0);
});

test("orientation fences reject missing, invalid and stale preview or save before dispatch", async () => {
  const { phone, post, saveTo } = await fixture();
  const observed = {
    orientation: phone.state.orientation,
    orientationEpoch: phone.state.orientationEpoch,
  };
  for (const invalid of [
    { orientation: undefined },
    { orientationEpoch: undefined },
    { orientation: "square" },
    { orientationEpoch: -1 },
    { orientationEpoch: 0.5 },
    { orientationEpoch: "0" },
  ]) {
    expect((await post("preview", { ...previewOf(phone.state), ...invalid })).status).toBe(400);
    expect((await post("save", { revision: 0, ...invalid })).status).toBe(400);
  }
  phone.rotate();
  expect((await post("preview", { ...previewOf(phone.state), ...observed })).status).toBe(409);
  expect((await post("save", { revision: phone.state.revision, ...observed })).status).toBe(409);
  phone.rotate();
  expect(phone.state.orientation).toBe(observed.orientation);
  expect((await post("preview", { ...previewOf(phone.state), ...observed })).status).toBe(409);
  expect((await post("save", { revision: phone.state.revision, ...observed })).status).toBe(409);
  expect(phone.calls).toHaveLength(0);
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("independent layouts retain portrait choices and save both layouts from landscape", async () => {
  const { phone, post, saveTo } = await fixture();
  const portrait = {
    ...previewOf(phone.state),
    verticalOffsetDp: -93,
    design: { ...phone.state.design, controlsHeightDp: 391 },
    halo: { ...phone.state.halo, variant: "contained" as const, containedSizePercent: 95 },
  };
  expect((await post("preview", portrait)).status).toBe(200);
  phone.rotate();
  expect(layoutOf(phone.state)).toEqual(defaultLandscapeLayout());
  const landscape = {
    ...previewOf(phone.state),
    verticalOffsetDp: -17,
    personaSide: "right" as const,
    design: { ...phone.state.design, controlsHeightDp: 247 },
  };
  expect((await post("preview", landscape)).status).toBe(200);
  expect(phone.state.otherLayout).toEqual(layoutOf(portrait));
  const reset = resetPreview(previewOf(phone.state), phone.state, "position");
  expect(reset.horizontalOffsetDp).toBe(0);
  expect(reset.verticalOffsetDp).toBe(-17);
  expect(reset.orientation).toBe("landscape");
  expect(reset.personaSide).toBe("right");
  expect(phone.state.otherLayout).toEqual(layoutOf(portrait));
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileLayout(saved, "portrait")).toEqual(layoutOf(portrait));
  expect(profileLayout(saved, "landscape")).toEqual(layoutOf(landscape));
  phone.rotate();
  expect(layoutOf(phone.state)).toEqual(layoutOf(portrait));
  expect(phone.state.otherLayout).toEqual(layoutOf(landscape));
});

test("handedness mirrors manual position in either landscape and preserves all other choices", () => {
  for (const orientation of ["landscape", "landscape-reverse"] as const) {
    const current = { ...previewOf(initial()), orientation, horizontalOffsetDp: -44 };
    const mirrored = withPersonaSide(current, "right");
    expect(mirrored).toEqual({ ...current, personaSide: "right", horizontalOffsetDp: 44 });
    expect(withPersonaSide(mirrored, "right")).toBe(mirrored);
    expect(withPersonaSide(mirrored, "left")).toEqual(current);
    const defaults = {
      ...initial(),
      defaultPersonaSide: "left" as const,
      defaultHorizontalOffsetDp: -42,
    };
    expect(resetPreview(mirrored, defaults, "position").horizontalOffsetDp).toBe(42);
    expect(resetPreview(current, defaults, "position").horizontalOffsetDp).toBe(-42);
  }
  for (const orientation of ["portrait", "portrait-reverse"] as const) {
    const current = { ...previewOf(initial()), orientation };
    expect(withPersonaSide(current, "right")).toBe(current);
  }
});

test("balanced handedness uses the opposite production rotation and retains appearance", async () => {
  const production = parseProfile(
    await Bun.file(new URL("../../design/shipping-profile.json", import.meta.url)).text(),
  );
  for (const orientation of ["landscape", "landscape-reverse"] as const) {
    const adopted = profileLayout(production, orientation);
    const other = profileLayout(
      production,
      orientation === "landscape" ? "landscape-reverse" : "landscape",
    );
    const current = {
      ...previewOf(initial()),
      orientation,
      personaSide: "right" as const,
      horizontalOffsetDp: 193,
      appearanceOverrides: ["halo" as const],
      showPushToTalk: false,
    };
    current.halo.colors.idle = "#123456";
    current.design.spacing.paddingDp = 31;
    const result = balancedHandedLayout(current, production);
    expect(result).toEqual({
      ...current,
      scales: other.scales,
      horizontalOffsetDp: -other.horizontalOffsetDp,
      halo: { ...current.halo, containedSizePercent: other.halo.containedSizePercent },
      design: {
        ...current.design,
        controlsHeightDp: other.design.controlsHeightDp,
        controlsWithoutPttDp: other.design.controlsWithoutPttDp,
        holdSharePercent: other.design.holdSharePercent,
      },
    });
    const sameHand = balancedHandedLayout(
      { ...current, personaSide: adopted.personaSide },
      production,
    );
    expect(sameHand.horizontalOffsetDp).toBe(adopted.horizontalOffsetDp);
    expect(sameHand.design.controlsHeightDp).toBe(adopted.design.controlsHeightDp);
  }
  const portrait = previewOf(initial());
  expect(balancedHandedLayout(portrait, production)).toBe(portrait);
});

test("version 10 preserves portrait bytes and seeds inherited landscape appearance in memory", () => {
  const old = profile({
    ...initial(),
    verticalOffsetDp: -187,
    scales: { speaking: 119, listening: 36, idle: 82 },
    personaSide: "right",
    halo: { ...defaultHalo(), variant: "contained", containedSizePercent: 113 },
    design: { ...defaultDesign, controlsHeightDp: 472 },
  });
  const encoded = JSON.stringify(old);
  const parsed = parseProfile(encoded);
  const portrait = profileLayout(parsed, "portrait");
  const landscape = profileLayout(parsed, "landscape");
  expect(portrait.verticalOffsetDp).toBe(-187);
  expect(portrait.design.controlsHeightDp).toBe(472);
  expect(portrait.halo.variant).toBe("contained");
  expect(portrait.personaSide).toBe("left");
  expect(landscape).toEqual({
    ...defaultLandscapeLayout(),
    design: { ...defaultDesign, spacing: legacySpacing() },
    spirit: defaultSpirit(),
  });
  landscape.design.traces.weightPercent = 209;
  landscape.halo.colors.idle = "#ffffff";
  portrait.design.traces.weightPercent = 217;
  expect(profileLayout(parsed, "landscape")).toEqual({
    ...defaultLandscapeLayout(),
    design: { ...defaultDesign, spacing: legacySpacing() },
    spirit: defaultSpirit(),
  });
  expect(JSON.stringify(withoutThinkingWingspan(parsed))).toBe(encoded);
});

test("a Save receipt is checked against both requested layouts even after the phone rotates", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.state.verticalOffsetDp = -71;
  phone.state.otherLayout.verticalOffsetDp = 28;
  phone.rotateDuringSave = true;
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  expect(phone.state.orientation).toBe("landscape");
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(profileLayout(saved, "portrait").verticalOffsetDp).toBe(-71);
  expect(profileLayout(saved, "landscape").verticalOffsetDp).toBe(28);
  expect(equalLayout(profileLayout(saved, "portrait"), phone.state.otherLayout)).toBe(true);
});

test("wrong inactive layout or hidden side receipts cannot create a host copy", async () => {
  for (const field of ["wrongOtherReceipt", "wrongSideReceipt"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone[field] = true;
    phone.rotateDuringSave = true;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("protocol 21 validates independent layouts and fits bounded profile and receipt frames", async () => {
  const state = initial();
  const profile = currentProfile(state);
  for (const invalid of [
    undefined,
    { ...profile.landscape, personaSide: "middle" },
    { ...profile.landscape, scales: { ...defaults, idle: 121 } },
    { ...profile.landscape, extra: 1 },
  ]) {
    expect(() => parseProfile(JSON.stringify({ ...profile, landscape: invalid }))).toThrow();
    for (const field of ["otherLayout", "savedOtherLayout"])
      expect(() => parseState({ ...state, [field]: invalid })).toThrow();
  }
  for (const field of ["personaSide", "savedPersonaSide", "defaultPersonaSide"])
    expect(() => parseState({ ...state, [field]: "middle" })).toThrow();
  const encoded = JSON.stringify(profile, null, 2);
  expect(encoded.length).toBeLessThanOrEqual(8192);
  const frame = JSON.stringify({ id: 1, state, profile: encoded });
  expect(Buffer.byteLength(frame)).toBeLessThan(16384);
  const { peer, phone } = await wire();
  const reply = phone.request({
    method: "save",
    revision: 0,
    orientation: "portrait",
    orientationEpoch: 0,
  });
  peer.write(`${frame}\n`);
  expect((await reply).profile).toBe(encoded);
});

test("spacing has exact bounded integer fields at every live and saved boundary", async () => {
  const { phone, post } = await fixture();
  const spacing = defaultSpacing();
  const invalid: unknown[] = [null, {}, [], undefined, { ...spacing, extra: 1 }];
  for (const field of spacingFields) {
    const [min, max] = spacingBounds[field];
    for (const amount of [min, max])
      expect(parseSpacing({ ...spacing, [field]: amount })[field]).toBe(amount);
    for (const amount of [min - 1, max + 1, 0.5, "10", null, undefined, Infinity, NaN])
      invalid.push({ ...spacing, [field]: amount });
  }
  for (const spacing of invalid) {
    const design = { ...defaultDesign, spacing };
    expect(() => parseDesign(design)).toThrow();
    expect(() =>
      parseProfile(JSON.stringify({ ...currentProfile(phone.state), design })),
    ).toThrow();
    expect(() =>
      parseState({ ...phone.state, otherLayout: { ...phone.state.otherLayout, design } }),
    ).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), design })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
});

test("version 11 preserves both layouts and seeds only baseline spacing without changing saved bytes", () => {
  const source = initial();
  source.design.spacing = legacySpacing();
  source.otherLayout.design.spacing = legacySpacing();
  source.verticalOffsetDp = -96;
  source.design.controlsHeightDp = 479;
  source.otherLayout.design.controlsHeightDp = 249;
  source.otherLayout.verticalOffsetDp = 108;
  source.otherLayout.personaSide = "right";
  source.otherLayout.halo.containedSizePercent = 119;
  source.otherLayout.design.traces.personaSpacingPercent = 177;
  const current = currentProfile(source);
  const old = {
    ...versionFourteen(current),
    version: 11 as const,
    design: versionTenDesign(current.design),
    landscape: {
      ...versionFourteen(current.landscape),
      design: versionTenDesign(current.landscape.design),
    },
  };
  const encoded = JSON.stringify(old);
  const parsed = parseProfile(encoded);
  expect(parsed.version).toBe(11);
  const portrait = profileLayout(parsed, "portrait");
  const landscape = profileLayout(parsed, "landscape");
  expect(portrait).toEqual({
    ...layoutOf(source),
    design: { ...source.design, controlsWithoutPttDp: source.design.controlsHeightDp },
    appearanceOverrides: [],
  });
  expect(landscape).toEqual({
    ...source.otherLayout,
    design: {
      ...source.otherLayout.design,
      controlsWithoutPttDp: source.otherLayout.design.controlsHeightDp,
    },
    appearanceOverrides: ["halo", "spirit", "traces"],
  });
  expect(portrait.design.spacing).toEqual(legacySpacing());
  expect(landscape.design.spacing).toEqual(legacySpacing());
  portrait.design.spacing.sideMarginPercent = 11;
  landscape.design.spacing.sideMarginPercent = 188;
  expect(profileLayout(parsed, "portrait").design.spacing).toEqual(legacySpacing());
  expect(profileLayout(parsed, "landscape").design.spacing).toEqual(legacySpacing());
  expect(JSON.stringify(withoutThinkingWingspan(parsed))).toBe(encoded);
  expect(() => parseProfile(JSON.stringify({ ...old, design: current.design }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...old, landscape: current.landscape }))).toThrow();
});

test("theme and muted presence survive layout switches, resets and explicit Save", async () => {
  const { phone, post, saveTo } = await fixture();
  for (const theme of ["bright", "quiet", "grayscale"] as const)
    for (const mutedPresence of ["tide", "off"] as const) {
      expect(
        (await post("preview", { ...previewOf(phone.state), theme, mutedPresence })).status,
      ).toBe(200);
      expect(phone.state.theme).toBe(theme);
      expect(phone.state.mutedPresence).toBe(mutedPresence);
    }
  phone.rotate();
  expect(phone.state.theme).toBe("grayscale");
  expect(phone.state.mutedPresence).toBe("off");
  const reset = resetPreview(previewOf(phone.state), phone.state, "spacing");
  expect(reset.theme).toBe("grayscale");
  expect(reset.mutedPresence).toBe("off");
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const savedText = await readFile(saveTo, "utf8");
  const saved = parseProfile(savedText);
  expect(savedText).toContain('"theme"');
  expect(savedText).toContain('"mutedPresence"');
  expect(() => parseProfile(JSON.stringify({ ...saved, theme: "quiet" }))).not.toThrow();
  expect(() => parseProfile(JSON.stringify({ ...saved, mutedPresence: "off" }))).not.toThrow();
  for (const invalid of [
    { theme: "dark" },
    { theme: undefined },
    { mutedPresence: "always" },
    { mutedPresence: undefined },
  ]) {
    expect(() => parseState({ ...phone.state, ...invalid })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), ...invalid })).status).toBe(400);
  }
});

test("spacing reset drafts isolate each field or the group and preserve session modes and existing state snapshots", () => {
  const state = initial();
  state.theme = "quiet";
  state.mutedPresence = "off";
  state.design.spacing = {
    paddingDp: 31,
    sideMarginPercent: 165,
    edgeClearancePercent: 53,
    sectionGapDp: 49,
    channelGapDp: 32,
    pushGapDp: 41,
  };
  const original = structuredClone(state);
  const current = previewOf(state);
  for (const field of spacingFields) {
    const reset = resetPreview(current, state, `spacing-${field}`);
    expect(reset).toEqual({
      ...current,
      design: {
        ...current.design,
        spacing: { ...current.design.spacing, [field]: defaultSpacing()[field] },
      },
    });
  }
  const reset = resetPreview(current, state, "spacing");
  expect(reset).toEqual({ ...current, design: { ...current.design, spacing: defaultSpacing() } });
  for (const target of [
    "controls",
    "size",
    "position",
    "traces",
    "glow",
    "animation",
    "colors",
    "light",
    "spirit-colors",
  ] as const) {
    const reset = resetPreview(current, state, target);
    expect(reset.design.spacing).toEqual(current.design.spacing);
    expect(reset.theme).toBe("quiet");
    expect(reset.mutedPresence).toBe("off");
  }
  expect(state).toEqual(original);
});

test("spacing edits from either orientation update both saved layouts and every field must match the receipt", async () => {
  const { phone, post, saveTo } = await fixture();
  const portrait = { ...defaultSpacing(), sideMarginPercent: 155, sectionGapDp: 57, pushGapDp: 34 };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, spacing: portrait },
      })
    ).status,
  ).toBe(200);
  phone.rotate();
  const landscape = { ...defaultSpacing(), edgeClearancePercent: 44, channelGapDp: 31 };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, spacing: landscape },
      })
    ).status,
  ).toBe(200);
  expect(phone.state.otherLayout.design.spacing).toEqual(landscape);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(profileLayout(saved, "portrait").design.spacing).toEqual(landscape);
  expect(profileLayout(saved, "landscape").design.spacing).toEqual(landscape);
  for (const field of spacingFields) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongSpacingReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("provisional portrait defaults are separate from landscape and legacy profile migration", () => {
  const portrait = defaultPortraitLayout();
  const landscape = defaultLandscapeLayout();
  expect(portrait.scales).toEqual({ speaking: 78, listening: 56, idle: 78 });
  expect(portrait.verticalOffsetDp).toBe(-22);
  expect(portrait.design.controlsHeightDp).toBe(387);
  expect(portrait.design.holdSharePercent).toBe(40.9);
  expect(portrait.design.traces).toEqual({
    ...defaultTraces(),
    pattern: "parallel",
    stancePercent: 130,
    weightPercent: 175,

    glowPercent: 0,
    personaSpacingPercent: 100,
    footSpacingPercent: 100,
  });
  expect(portrait.halo).toEqual({ ...defaultHalo(), variant: "contained" });
  expect(portrait.spirit).toEqual({ ...defaultSpirit(), persona: "follow" });
  expect(landscape.scales.listening).toBe(58);
  expect(landscape.design.controlsHeightDp).toBe(262);
  expect(landscape.verticalOffsetDp).toBe(0);
  expect(landscape.halo.variant).toBe("contained");
  expect(appearanceOf(landscape)).toEqual(appearanceOf(portrait));
  expect(
    profileLayout(parseProfile(JSON.stringify(profile(initial()))), "portrait").verticalOffsetDp,
  ).toBe(35);
});

test("muted appearance requires exact bounded session fields before phone dispatch", async () => {
  const { phone, post } = await fixture();
  const baseline = defaultMutedTuning();
  expect(baseline).toEqual({
    textSizeSp: 14,
    brightnessPercent: 0,
    driftPercent: 100,
    breathPercent: 0,
    cycleSeconds: 14,
    motion: "float",
  });
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    {},
    { ...baseline, extra: 1 },
    { ...baseline, motion: "wave" },
    { ...baseline, motion: undefined },
  ];
  for (const field of mutedTuningAmounts) {
    const [min, max] = mutedTuningBounds[field];
    for (const amount of [min, max])
      expect(parseMutedTuning({ ...baseline, [field]: amount })[field]).toBe(amount);
    for (const amount of [min - 1, max + 1, min + 0.5, "14", null, undefined, Infinity, NaN])
      invalid.push({ ...baseline, [field]: amount });
  }
  for (const mutedTuning of invalid) {
    expect(() => parseMutedTuning(mutedTuning)).toThrow();
    expect(() => parseState({ ...phone.state, mutedTuning })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), mutedTuning })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
});

test("muted appearance survives rotation and Off and saves in profile19", async () => {
  const { phone, post, saveTo } = await fixture();
  const before = currentProfile(phone.state);
  const mutedTuning = {
    textSizeSp: 27,
    brightnessPercent: 83,
    driftPercent: 284,
    breathPercent: 76,
    cycleSeconds: 9,
    motion: "ripple" as const,
  };
  expect((await post("preview", { ...previewOf(phone.state), mutedTuning })).status).toBe(200);
  expect(phone.state.mutedTuning).toEqual(mutedTuning);
  const draft = previewOf(phone.state);
  draft.mutedTuning.textSizeSp = 12;
  expect(phone.state.mutedTuning.textSizeSp).toBe(27);
  phone.rotate();
  expect(phone.state.mutedTuning).toEqual(mutedTuning);
  expect((await post("preview", { ...previewOf(phone.state), mutedPresence: "off" })).status).toBe(
    200,
  );
  expect(phone.state.mutedTuning).toEqual(mutedTuning);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const savedText = await readFile(saveTo, "utf8");
  const saved = parseProfile(savedText);
  expect(saved).toEqual(completeProfile(phone.state));
  expect(saved.version).toBe(23);
  expect(savedText).toContain('"mutedTuning"');
  expect(() => parseProfile(JSON.stringify({ ...saved, mutedTuning }))).not.toThrow();
  expect(() =>
    parseState({ ...phone.state, otherLayout: { ...phone.state.otherLayout, mutedTuning } }),
  ).toThrow();
  expect(() =>
    parseProfile(JSON.stringify({ ...before, landscape: { ...before.landscape, mutedTuning } })),
  ).toThrow();
});

test("muted appearance group and individual resets preserve Tide/Off, theme and both layouts", () => {
  const state = initial();
  state.theme = "quiet";
  state.mutedPresence = "off";
  state.mutedTuning = {
    textSizeSp: 30,
    brightnessPercent: 90,
    driftPercent: 260,
    breathPercent: 87,
    cycleSeconds: 24,
    motion: "ripple",
  };
  state.otherLayout.verticalOffsetDp = 93;
  const original = structuredClone(state);
  const current = previewOf(state);
  for (const field of mutedTuningFields) {
    expect(resetPreview(current, state, `muted-${field}`)).toEqual({
      ...current,
      mutedTuning: { ...current.mutedTuning, [field]: defaultMutedTuning()[field] },
    });
  }
  expect(resetPreview(current, state, "muted-appearance")).toEqual({
    ...current,
    mutedTuning: defaultMutedTuning(),
  });
  for (const target of [
    "spacing",
    "controls",
    "size",
    "position",
    "traces",
    "glow",
    "animation",
    "colors",
    "light",
    "spirit-colors",
  ] as const)
    expect(resetPreview(current, state, target).mutedTuning).toEqual(current.mutedTuning);
  expect(state).toEqual(original);
});

test("muted tuning edits retain orientation and connection fences", async () => {
  const { phone, post } = await fixture();
  const before = previewOf(phone.state);
  before.mutedTuning.driftPercent = 291;
  phone.rotate();
  expect((await post("preview", before)).status).toBe(409);
  phone.rotate();
  expect((await post("preview", before)).status).toBe(409);
  phone.generation++;
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        generation: 1,
        mutedTuning: before.mutedTuning,
      })
    ).status,
  ).toBe(409);
  expect(phone.calls).toHaveLength(0);
  expect(phone.state.mutedTuning).toEqual(defaultMutedTuning());
});

test("profile12 keeps raw spacing bytes and uses portrait custom spacing in both effective layouts", () => {
  const state = initial();
  state.design.spacing = {
    ...defaultSpacing(),
    sideMarginPercent: 159,
    edgeClearancePercent: 63,
    sectionGapDp: 58,
    channelGapDp: 34,
    pushGapDp: 45,
  };
  state.otherLayout.design.spacing = {
    ...defaultSpacing(),
    sideMarginPercent: 27,
    edgeClearancePercent: 181,
    sectionGapDp: 14,
    channelGapDp: 3,
    pushGapDp: 7,
  };
  const latest = currentProfile(state);
  const old = {
    ...versionFourteen(latest),
    version: 12 as const,
    design: versionTwelveDesign(latest.design),
    landscape: {
      ...versionFourteen(latest.landscape),
      design: versionTwelveDesign(latest.landscape.design),
    },
  };
  const encoded = JSON.stringify(old);
  const parsed = parseProfile(encoded);
  expectLegacyProfile(parsed, old);
  const portrait = profileLayout(parsed, "portrait");
  const landscape = profileLayout(parsed, "landscape");
  expect(portrait.design.spacing).toEqual({ ...state.design.spacing, paddingDp: -1 });
  expect(landscape.design.spacing).toEqual({ ...state.design.spacing, paddingDp: -1 });
  portrait.design.spacing.channelGapDp = 0;
  landscape.design.spacing.sideMarginPercent = 200;
  expect(JSON.stringify(withoutThinkingWingspan(parsed))).toBe(encoded);
  expect(() => parseProfile(JSON.stringify({ ...old, design: latest.design }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...old, landscape: latest.landscape }))).toThrow();
  for (const spacing of [
    undefined,
    { ...old.design.spacing, sectionGapDp: -1 },
    { ...old.design.spacing, extra: 1 },
    { ...old.design.spacing, paddingDp: -1 },
  ])
    expect(() =>
      parseProfile(JSON.stringify({ ...old, design: { ...old.design, spacing } })),
    ).toThrow();
});

test("shared unified padding and its reset preserve hidden legacy values and other layout geometry", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.state.design.spacing = {
    ...legacySpacing(),
    sideMarginPercent: 145,
    edgeClearancePercent: 72,
    sectionGapDp: 33,
    channelGapDp: 27,
    pushGapDp: 41,
  };
  const before = structuredClone(phone.state);
  const selection = previewOf(phone.state);
  const resetPadding = resetPreview(selection, phone.state, "spacing-paddingDp");
  expect(resetPadding.design.spacing).toEqual({ ...before.design.spacing, paddingDp: 16 });
  expect(resetPreview(selection, phone.state, "spacing-sectionGapDp").design.spacing).toEqual({
    ...before.design.spacing,
    sectionGapDp: 0,
  });
  expect(resetPreview(selection, phone.state, "spacing").design.spacing).toEqual(defaultSpacing());
  const edited = {
    ...selection,
    design: { ...selection.design, spacing: { ...selection.design.spacing, paddingDp: 24 } },
  };
  expect((await post("preview", edited)).status).toBe(200);
  expect(phone.state.design.spacing).toEqual({ ...before.design.spacing, paddingDp: 24 });
  expect(phone.state.otherLayout).toEqual({
    ...before.otherLayout,
    design: { ...before.otherLayout.design, spacing: { ...before.design.spacing, paddingDp: 24 } },
  });
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileLayout(saved, "portrait").design.spacing).toEqual(phone.state.design.spacing);
  expect(profileLayout(saved, "landscape")).toEqual(phone.state.otherLayout);
  for (const spacing of [
    { ...defaultSpacing(), paddingDp: undefined },
    { ...defaultSpacing(), paddingDp: -2 },
    { ...defaultSpacing(), paddingDp: 41 },
    { ...defaultSpacing(), paddingDp: 16.5 },
    { ...defaultSpacing(), sectionGapDp: -1 },
  ])
    expect(
      (
        await post("preview", {
          ...previewOf(phone.state),
          design: { ...phone.state.design, spacing },
        })
      ).status,
    ).toBe(400);
});

test("negative muted brightness is session-only and resets to the unchanged zero baseline", async () => {
  const { phone, post } = await fixture();
  for (const brightnessPercent of [-100, -63, -1, 0, 100]) {
    expect(
      (
        await post("preview", {
          ...previewOf(phone.state),
          mutedTuning: { ...phone.state.mutedTuning, brightnessPercent },
        })
      ).status,
    ).toBe(200);
    expect(phone.state.mutedTuning.brightnessPercent).toBe(brightnessPercent);
  }
  const negative = {
    ...previewOf(phone.state),
    mutedTuning: { ...phone.state.mutedTuning, brightnessPercent: -78 },
  };
  expect(
    resetPreview(negative, phone.state, "muted-brightnessPercent").mutedTuning.brightnessPercent,
  ).toBe(0);
  expect(currentProfile(phone.state)).not.toHaveProperty("mutedTuning");
});

test("center indicator styles and visibility scopes require exact valid session values", async () => {
  const { phone, post } = await fixture();
  expect(mutedPresences).toEqual(["off", "tide", "words", "channels", "labeled", "contacts"]);
  expect(presenceScopes).toEqual(["both-muted", "any-muted", "always"]);
  for (const mutedPresence of mutedPresences)
    for (const presenceScope of presenceScopes) {
      expect(
        (await post("preview", { ...previewOf(phone.state), mutedPresence, presenceScope })).status,
      ).toBe(200);
      expect(phone.state.mutedPresence).toBe(mutedPresence);
      expect(phone.state.presenceScope).toBe(presenceScope);
    }
  const count = phone.calls.length;
  for (const invalid of [
    { mutedPresence: "thinking" },
    { mutedPresence: "icons" },
    { presenceScope: "either" },
    { presenceScope: undefined },
    { presenceScope: null },
    { presenceScope: 1 },
  ]) {
    expect(() => parseState({ ...phone.state, ...invalid })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), ...invalid })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(count);
});

test("indicator style and scope persist across rotation, Off, appearance resets and Save", async () => {
  const { phone, post, saveTo } = await fixture();
  const mutedTuning = {
    ...defaultMutedTuning(),
    brightnessPercent: -43,
    textSizeSp: 27,
    driftPercent: 235,
  };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        mutedPresence: "contacts",
        presenceScope: "always",
        mutedTuning,
      })
    ).status,
  ).toBe(200);
  phone.rotate();
  expect(phone.state.mutedPresence).toBe("contacts");
  expect(phone.state.presenceScope).toBe("always");
  const reset = resetPreview(previewOf(phone.state), phone.state, "muted-appearance");
  expect(reset.mutedTuning).toEqual(defaultMutedTuning());
  expect(reset.mutedPresence).toBe("contacts");
  expect(reset.presenceScope).toBe("always");
  for (const style of ["off", "tide", "labeled"] as const) {
    expect(
      (await post("preview", { ...previewOf(phone.state), mutedPresence: style })).status,
    ).toBe(200);
    expect(phone.state.presenceScope).toBe("always");
    expect(phone.state.mutedTuning).toEqual(mutedTuning);
  }
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const savedText = await readFile(saveTo, "utf8");
  const saved = parseProfile(savedText);
  expect(saved).toEqual(completeProfile(phone.state));
  expect(saved.version).toBe(23);
  expect(savedText).toContain('"presenceScope"');
  expect(savedText).toContain('"mutedPresence"');
  expect(() => parseProfile(JSON.stringify({ ...saved, presenceScope: "always" }))).not.toThrow();
  expect(() =>
    parseState({
      ...phone.state,
      otherLayout: { ...phone.state.otherLayout, presenceScope: "always" },
    }),
  ).toThrow();
});

test("profile13 preserves both layouts and bytes while trace tips gain only baseline defaults", () => {
  const source = initial();
  source.design.traces.personaSpacingPercent = 183;
  source.design.traces.stancePercent = 119;
  source.design.spacing.paddingDp = 27;
  source.otherLayout.design.traces.footSpacingPercent = 67;
  source.otherLayout.design.traces.glowPercent = 42;
  source.otherLayout.design.spacing.paddingDp = -1;
  const latest = currentProfile(source);
  const old = {
    ...versionFourteen(latest),
    version: 13 as const,
    design: versionThirteenDesign(latest.design),
    landscape: {
      ...versionFourteen(latest.landscape),
      design: versionThirteenDesign(latest.landscape.design),
    },
  };
  const encoded = JSON.stringify(old);
  const parsed = parseProfile(encoded);
  expectLegacyProfile(parsed, old);
  const portrait = profileLayout(parsed, "portrait");
  const landscape = profileLayout(parsed, "landscape");
  expect(portrait).toEqual({
    ...layoutOf(source),
    design: { ...source.design, controlsWithoutPttDp: source.design.controlsHeightDp },
    appearanceOverrides: [],
  });
  expect(landscape).toEqual({
    ...source.otherLayout,
    design: { ...source.otherLayout.design, spacing: { ...source.design.spacing } },
    appearanceOverrides: [...appearanceGroups],
  });
  portrait.design.traces.reachDp = 87;
  landscape.design.traces.fadeLengthDp = 0;
  expect(JSON.stringify(withoutThinkingWingspan(parsed))).toBe(encoded);
  for (const field of traceTipFields) {
    const traces = { ...old.design.traces, [field]: defaultTraces()[field] };
    expect(() =>
      parseProfile(JSON.stringify({ ...old, design: { ...old.design, traces } })),
    ).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({
          ...old,
          landscape: {
            ...old.landscape,
            design: {
              ...old.landscape.design,
              traces: { ...old.landscape.design.traces, [field]: defaultTraces()[field] },
            },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({
          ...latest,
          design: { ...latest.design, traces: { ...latest.design.traces, [field]: undefined } },
        }),
      ),
    ).toThrow();
  }
});

test("trace tip individual resets and Reset traces preserve unrelated tuning", () => {
  const state = initial();
  state.design.traces = {
    ...state.design.traces,
    reachDp: 89,
    fadeLengthDp: 63,
    tipOpacityPercent: 71,
    glowPercent: 48,
    stancePercent: 142,
  };
  state.otherLayout.design.traces.reachDp = -23;
  const before = structuredClone(state);
  const current = previewOf(state);
  for (const field of traceTipFields) {
    expect(resetPreview(current, state, `trace-${field}`)).toEqual({
      ...current,
      design: {
        ...current.design,
        traces: { ...current.design.traces, [field]: defaultTraces()[field] },
      },
    });
  }
  expect(resetPreview(current, state, "traces")).toEqual({
    ...current,
    design: { ...current.design, traces: { ...state.defaultDesign.traces, glowPercent: 48 } },
  });
  for (const target of [
    "glow",
    "spacing",
    "controls",
    "size",
    "position",
    "animation",
    "colors",
    "light",
    "spirit-colors",
    "muted-appearance",
  ] as const) {
    const reset = resetPreview(current, state, target);
    for (const field of traceTipFields)
      expect(reset.design.traces[field]).toBe(current.design.traces[field]);
  }
  expect(state).toEqual(before);
});

test("trace reach and fade save independently by orientation including hard ends and tip opacity", async () => {
  const { phone, post, saveTo } = await fixture();
  const portrait = {
    ...phone.state.design.traces,
    reachDp: 92,
    fadeLengthDp: 0,
    tipOpacityPercent: 64,
  };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, traces: portrait },
      })
    ).status,
  ).toBe(200);
  phone.rotate();
  const landscape = {
    ...phone.state.design.traces,
    reachDp: -31,
    fadeLengthDp: 78,
    tipOpacityPercent: 25,
  };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, traces: landscape },
      })
    ).status,
  ).toBe(200);
  expect(phone.state.otherLayout.design.traces).toEqual(portrait);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileLayout(saved, "portrait").design.traces).toEqual(portrait);
  expect(profileLayout(saved, "landscape").design.traces).toEqual(landscape);
});

// The baseline fixture models an existing portrait with explicit appearance overrides.
// Inheritance scenarios start from the fresh studio defaults.
function inherit(phone: FakePhone) {
  const shared = defaultSharedAppearance();
  phone.state = {
    ...phone.state,
    ...defaultPortraitLayout(),
    sharedAppearance: shared,
    savedSharedAppearance: structuredClone(shared),
    defaultSharedAppearance: structuredClone(shared),
    savedAppearanceOverrides: [],
    otherLayout: defaultLandscapeLayout(),
    savedOtherLayout: defaultLandscapeLayout(),
  };
}

test("shared appearance edits reach both inherited layouts while size and horizontal position stay local", async () => {
  const { phone, post, saveTo } = await fixture();
  inherit(phone);
  const portrait = previewOf(phone.state);
  const edit = structuredClone(portrait);
  edit.design.traces.reachDp = 37;
  edit.design.traces.glowPercent = 29;
  edit.halo.colors.idle = "#abcdef";
  edit.halo.containedSizePercent = 109;
  edit.halo.thinkingWingspan = 7;
  edit.spirit.surface = "soft";
  expect((await post("preview", edit)).status).toBe(200);
  expect(appearanceOf(phone.state)).toEqual(appearanceOf(phone.state.otherLayout));
  expect(phone.state.otherLayout.halo.containedSizePercent).toBe(78);
  expect(phone.state.otherLayout.halo.thinkingWingspan).toBe(7);
  expect(phone.state.sharedAppearance).toEqual(appearanceOf(edit));
  phone.rotate();
  const selected = previewOf(phone.state);
  selected.horizontalOffsetDp = 83;
  selected.halo.containedSizePercent = 62;
  const inactive = structuredClone(phone.state.otherLayout);
  expect((await post("preview", selected)).status).toBe(200);
  expect(phone.state.otherLayout).toEqual(inactive);
  const reset = resetPreview(previewOf(phone.state), phone.state, "position");
  expect(reset.horizontalOffsetDp).toBe(0);
  expect(reset.verticalOffsetDp).toBe(selected.verticalOffsetDp);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(profileSharedAppearance(saved)).toEqual(phone.state.sharedAppearance);
  expect(profileLayout(saved, "landscape").horizontalOffsetDp).toBe(83);
  expect(profileLayout(saved, "portrait").halo.containedSizePercent).toBe(109);
});

test("override ON snapshots effective groups and OFF discards proposed local values without changing the shared base", async () => {
  const { phone, post } = await fixture();
  inherit(phone);
  const shared = structuredClone(phone.state.sharedAppearance);
  const local = previewOf(phone.state);
  local.appearanceOverrides = [...appearanceGroups];
  local.design.traces.reachDp = 76;
  local.design.traces.glowPercent = 93;
  local.halo.colors.idle = "#112233";
  local.halo.containedSizePercent = 111;
  local.halo.thinkingWingspan = 9;
  local.spirit.strengthPercent = 91;
  expect((await post("preview", local)).status).toBe(200);
  expect(appearanceOf(phone.state)).toEqual(shared);
  expect(phone.state.halo.containedSizePercent).toBe(111);
  expect(phone.state.halo.thinkingWingspan).toBe(2);
  expect((await post("preview", local)).status).toBe(200);
  expect(appearanceOf(phone.state)).toEqual(appearanceOf(local));
  expect(phone.state.halo.thinkingWingspan).toBe(9);
  expect(phone.state.sharedAppearance).toEqual(shared);
  phone.rotate();
  const landscape = previewOf(phone.state);
  landscape.design.traces.weightPercent = 214;
  landscape.design.traces.glowPercent = 18;
  landscape.halo.colors.idle = "#445566";
  landscape.spirit.strengthPercent = 23;
  const overridden = structuredClone(phone.state.otherLayout);
  expect((await post("preview", landscape)).status).toBe(200);
  expect(phone.state.otherLayout).toEqual(overridden);
  expect(phone.state.sharedAppearance).toEqual(appearanceOf(landscape));
  phone.rotate();
  const discard = { ...previewOf(phone.state), appearanceOverrides: [] };
  expect((await post("preview", discard)).status).toBe(200);
  expect(appearanceOf(phone.state)).toEqual(appearanceOf(landscape));
  expect(phone.state.sharedAppearance).toEqual(appearanceOf(landscape));
  expect(phone.state.halo.containedSizePercent).toBe(111);
});

test("appearance resets use shared defaults even for overrides while local resets retain both appearance and inactive axis", () => {
  const state = initial();
  state.defaultSharedAppearance = defaultSharedAppearance();
  const selection = previewOf(state);
  selection.orientation = "landscape";
  selection.horizontalOffsetDp = 92;
  selection.verticalOffsetDp = -137;
  selection.design.traces.reachDp = 54;
  selection.halo.colors.idle = "#112233";
  selection.halo.thinkingWingspan = 8;
  selection.spirit.persona = "fixed";
  expect(resetPreview(selection, state, "traces").design.traces).toEqual({
    ...state.defaultSharedAppearance.traces,
    glowPercent: selection.design.traces.glowPercent,
  });
  expect(resetPreview(selection, state, "colors").halo.colors).toEqual(
    state.defaultSharedAppearance.halo.colors,
  );
  expect(resetPreview(selection, state, "spirit-colors").spirit.persona).toBe("follow");
  expect(resetPreview(selection, state, "thinking-wingspan").halo.thinkingWingspan).toBe(2);
  const reset = resetPreview(selection, state, "position");
  expect(reset.horizontalOffsetDp).toBe(0);
  expect(reset.verticalOffsetDp).toBe(-137);
  expect(appearanceOf(reset)).toEqual(appearanceOf(selection));
  expect(reset.appearanceOverrides).toEqual(selection.appearanceOverrides);
});

test("profile14 migration distinguishes canonical, portrait-equal and explicitly customized landscape groups without rewriting", () => {
  const state = initial();
  state.design.traces.weightPercent = 221;
  state.design.traces.glowPercent = 34;
  state.halo.variant = "contained";
  state.spirit.persona = "follow";
  const latest = currentProfile(state);
  const canonical = withoutThinkingWingspan({
    ...versionFourteen(defaultLandscapeLayout()),
    design: versionSixteenDesign(defaultDesign),
    halo: defaultHalo(),
    spirit: defaultSpirit(),
  });
  const old = {
    ...versionFourteen(latest),
    design: versionSixteenDesign(latest.design),
    version: 14 as const,
    landscape: canonical,
  };
  const bytes = JSON.stringify(old, null, 2);
  const parsed = parseProfile(bytes);
  expect(JSON.stringify(withoutThinkingWingspan(parsed), null, 2)).toBe(bytes);
  expect(profileLayout(parsed, "portrait").appearanceOverrides).toEqual([]);
  expect(profileLayout(parsed, "landscape").appearanceOverrides).toEqual([]);
  expect(appearanceOf(profileLayout(parsed, "landscape"))).toEqual(appearanceOf(state));
  const equal = {
    ...old,
    landscape: {
      ...canonical,
      design: versionSixteenDesign(state.design),
      halo: withoutThinkingWingspan({
        ...structuredClone(state.halo),
        containedSizePercent: 117,
      }),
      spirit: { ...state.spirit },
    },
  };
  expect(
    profileLayout(parseProfile(JSON.stringify(equal)), "landscape").appearanceOverrides,
  ).toEqual([]);
  for (const group of appearanceGroups) {
    const custom = structuredClone(old);
    if (group === "traces") custom.landscape.design.traces.reachDp = 19;
    if (group === "glow") custom.landscape.design.traces.glowPercent = 18;
    if (group === "halo") custom.landscape.halo.colors.idle = "#123456";
    if (group === "spirit") custom.landscape.spirit.strengthPercent = 71;
    const migrated = profileLayout(parseProfile(JSON.stringify(custom)), "landscape");
    expect(migrated.appearanceOverrides).toEqual([group]);
    expect(
      withoutThinkingWingspan(appearanceOf(migrated)[group === "glow" ? "glowPercent" : group]),
    ).toEqual(
      withoutThinkingWingspan(
        appearanceOf({
          ...defaultLandscapeLayout(),
          ...custom.landscape,
          design: {
            ...custom.landscape.design,
            controlsWithoutPttDp: custom.landscape.design.controlsHeightDp,
            traces: migrateTraces(custom.landscape.design.traces),
          },
        })[group === "glow" ? "glowPercent" : group],
      ),
    );
  }
  expect(() => parseProfile(JSON.stringify({ ...old, horizontalOffsetDp: 0 }))).toThrow();
  expect(() =>
    parseProfile(JSON.stringify({ ...old, landscape: { ...canonical, appearanceOverrides: [] } })),
  ).toThrow();
});

test("protocol21 strictly validates axes and override groups and accepts shared metadata only from the phone", async () => {
  const { phone, post } = await fixture();
  const saved = currentProfile(phone.state);
  for (const value of [
    undefined,
    null,
    "halo",
    ["unknown"],
    ["halo", "glow"],
    ["halo", "halo"],
    [1],
  ]) {
    expect(() => parsePreview({ ...previewOf(phone.state), appearanceOverrides: value })).toThrow();
    expect(() => parseState({ ...phone.state, savedAppearanceOverrides: value })).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, appearanceOverrides: value }))).toThrow();
  }
  for (const value of [-201, 201, 0.5, "0", null, undefined]) {
    expect(() => parsePreview({ ...previewOf(phone.state), horizontalOffsetDp: value })).toThrow();
    expect(() => parseState({ ...phone.state, defaultHorizontalOffsetDp: value })).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, horizontalOffsetDp: value }))).toThrow();
  }
  for (const invalid of [
    { ...saved.sharedAppearance, extra: 0 },
    { ...saved.sharedAppearance, traces: phone.state.design.traces },
    { ...saved.sharedAppearance, halo: phone.state.halo },
    { ...saved.sharedAppearance, glowPercent: -1 },
  ]) {
    expect(() => parseSharedAppearance(invalid)).toThrow();
    expect(() => parseState({ ...phone.state, sharedAppearance: invalid })).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, sharedAppearance: invalid }))).toThrow();
  }
  expect(
    (await post("preview", { ...previewOf(phone.state), sharedAppearance: saved.sharedAppearance }))
      .status,
  ).toBe(400);
  expect(phone.calls).toHaveLength(0);
});

test("Save receipts validate shared snapshot, flags, horizontal axis and raw inherited effective fields", async () => {
  for (const field of [
    "wrongSharedReceipt",
    "wrongOverrideReceipt",
    "wrongHorizontalReceipt",
    "wrongTraceReceipt",
  ] as const) {
    const { phone, post, saveTo } = await fixture();
    if (field === "wrongTraceReceipt") {
      inherit(phone);
      phone.wrongTraceReceipt = "reachDp";
    } else phone[field] = true;
    phone.rotateDuringSave = true;
    expect((await post("save", { revision: phone.state.revision })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("debug reply framing accepts65535 bytes and rejects65536 with or without a newline", async () => {
  const frame = JSON.stringify({ id: 1, state: initial() });
  const accepted = await wire();
  const pending = accepted.phone.request({ method: "get" });
  accepted.peer.write(`${frame}${" ".repeat(65535 - frame.length)}\n`);
  expect((await pending).state.protocol).toBe(30);
  for (const newline of ["", "\n"]) {
    const rejected = await wire();
    const pending = rejected.phone.request({ method: "get" });
    rejected.peer.write(`${frame}${" ".repeat(65536 - frame.length)}${newline}`);
    await expect(pending).rejects.toThrow("disconnected");
    expect(rejected.phone.state).toBeUndefined();
  }
  const profile = JSON.stringify(currentProfile(initial()));
  expect(parseProfile(profile.padEnd(8192, " ")).version).toBe(18);
  expect(() => parseProfile(profile.padEnd(8193, " "))).toThrow("Profile too large");
});

test("sounds validate exact shared saved fields and reject invalid settings before phone dispatch", async () => {
  const { phone, post } = await fixture();
  const current = currentProfile(phone.state);
  const invalid = [
    undefined,
    null,
    [],
    {},
    { ...defaultSounds(), extra: true },
    { family: "switch", volumePercent: 70 },
    { family: "off" },
    ...[-1, 101, 70.5, "70", NaN, Infinity].map((volumePercent) => ({
      family: "rocker-29",
      volumePercent,
    })),
  ];
  for (const sounds of invalid) {
    expect(() => parseSounds(sounds)).toThrow();
    expect(() => parsePreview({ ...previewOf(phone.state), sounds })).toThrow();
    for (const field of ["sounds", "savedSounds", "defaultSounds"])
      expect(() => parseState({ ...phone.state, [field]: sounds })).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...current, sounds }))).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), sounds })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
  for (const family of soundFamilies)
    for (const volumePercent of [0, 70, 100])
      expect(parseSounds({ family, volumePercent })).toEqual({ family, volumePercent });
  expect(() =>
    parseProfile(
      JSON.stringify({ ...current, landscape: { ...current.landscape, sounds: defaultSounds() } }),
    ),
  ).toThrow();
  expect(() =>
    parseState({
      ...phone.state,
      otherLayout: { ...phone.state.otherLayout, sounds: defaultSounds() },
    }),
  ).toThrow();
});

test("sound settings remain shared across rotation and independent of appearance overrides and local resets", async () => {
  const { phone, post, saveTo } = await fixture();
  const portrait = layoutOf(phone.state);
  const landscape = structuredClone(phone.state.otherLayout);
  const shared = structuredClone(phone.state.sharedAppearance);
  const sounds = { family: "rocker-29" as const, volumePercent: 43 };
  expect((await post("preview", { ...previewOf(phone.state), sounds })).status).toBe(200);
  expect(phone.state.sounds).toEqual(sounds);
  expect(layoutOf(phone.state)).toEqual(portrait);
  expect(phone.state.otherLayout).toEqual(landscape);
  expect(phone.state.sharedAppearance).toEqual(shared);
  expect(phone.state.savedSounds).toEqual(defaultSounds());
  expect(await Bun.file(saveTo).exists()).toBe(false);
  phone.rotate();
  expect(phone.state.sounds).toEqual(sounds);
  for (const target of [
    "size",
    "position",
    "traces",
    "glow",
    "colors",
    "animation",
    "light",
    "spirit-colors",
    "spacing",
    "controls",
    "muted-appearance",
  ] as const)
    expect(resetPreview(previewOf(phone.state), phone.state, target).sounds).toEqual(sounds);
  const soundsOff = { ...sounds, family: "off" as const };
  expect((await post("preview", { ...previewOf(phone.state), sounds: soundsOff })).status).toBe(
    200,
  );
  phone.rotate();
  expect(phone.state.sounds).toEqual(soundsOff);
  expect(phone.calls.every((command) => command["method"] === "preview")).toBe(true);
  expect(phone.calls).toHaveLength(2);
  const current = previewOf(phone.state);
  const reset = resetPreview(current, phone.state, "sounds");
  expect(reset).toEqual({ ...current, sounds: defaultSounds() });
  expect(current.sounds).toEqual(soundsOff);
});

test("profile15 and older retain strict bytes and default sounds only in memory", () => {
  const { sounds: _, ...latest } = currentProfile(initial());
  const previous = {
    ...latest,
    version: 15 as const,
    design: versionSixteenDesign(latest.design),
    landscape: { ...latest.landscape, design: versionSixteenDesign(latest.landscape.design) },
    sharedAppearance: {
      ...latest.sharedAppearance,
      traces: { ...latest.sharedAppearance.traces, offshootPercent: 0 },
    },
  };
  for (const old of [previous, profile(initial())]) {
    const bytes = JSON.stringify(old, null, 2);
    const loaded = parseProfile(bytes);
    expect(JSON.stringify(withoutThinkingWingspan(loaded), null, 2)).toBe(bytes);
    expect(profileSounds(loaded)).toEqual(defaultSounds());
    const changed = profileSounds(loaded);
    changed.family = "rocker-13";
    expect(profileSounds(loaded)).toEqual(defaultSounds());
    expect(() => parseProfile(JSON.stringify({ ...old, sounds: defaultSounds() }))).toThrow();
  }
  expect(profileLayout(parseProfile(JSON.stringify(previous)), "portrait")).toEqual(
    layoutOf(initial()),
  );
});

test("only exact sound receipts write the host profile and captured sound choices survive later rotation or edits", async () => {
  for (const field of ["family", "volumePercent"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.state.sounds = { family: "rocker-29", volumePercent: 41 };
    phone.wrongSoundsReceipt = field;
    phone.rotateDuringSave = true;
    expect((await post("save", { revision: phone.state.revision })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
  const { phone, post, saveTo } = await fixture();
  const captured = { family: "rocker-29" as const, volumePercent: 47 };
  phone.state.sounds = { ...captured };
  phone.rotateDuringSave = true;
  phone.changeSoundsDuringSave = true;
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileSounds(saved)).toEqual(captured);
  expect(phone.state.sounds).toEqual({ family: "off", volumePercent: 0 });
  expect(phone.state.savedSounds).toEqual(captured);
  expect(phone.state.orientation).toBe("landscape");
});

test("push-to-talk visibility is a strict saved shared boolean without layout fields", async () => {
  const { phone, post, saveTo } = await fixture();
  for (const showPushToTalk of [undefined, null, 0, 1, "false", [], {}]) {
    expect(() => parsePreview({ ...previewOf(phone.state), showPushToTalk })).toThrow();
    expect(() => parseState({ ...phone.state, showPushToTalk })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), showPushToTalk })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
  const selected = {
    ...previewOf(phone.state),
    sounds: { family: "rocker-29" as const, volumePercent: 39 },
    showPushToTalk: false,
  };
  const portrait = layoutOf(phone.state);
  const landscape = structuredClone(phone.state.otherLayout);
  expect((await post("preview", selected)).status).toBe(200);
  expect(phone.state.showPushToTalk).toBe(false);
  expect(layoutOf(phone.state)).toEqual(portrait);
  expect(phone.state.otherLayout).toEqual(landscape);
  phone.rotate();
  expect(phone.state.showPushToTalk).toBe(false);
  expect(phone.state.sounds).toEqual(selected.sounds);
  for (const target of [
    "controls",
    "size",
    "position",
    "sounds",
    "spacing",
    "traces",
    "glow",
    "muted-appearance",
  ] as const)
    expect(resetPreview(previewOf(phone.state), phone.state, target).showPushToTalk).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileVisualSettings(saved).showPushToTalk).toBe(phone.state.showPushToTalk);
  expect(profileLayout(saved, "portrait")).toEqual(portrait);
  expect(profileLayout(saved, "landscape")).toEqual(landscape);
  expect(profileSounds(saved)).toEqual(selected.sounds);
  expect((await post("preview", { ...previewOf(phone.state), showPushToTalk: true })).status).toBe(
    200,
  );
  expect(phone.state.design.holdSharePercent).toBe(landscape.design.holdSharePercent);
  expect(() => parseProfile(JSON.stringify({ ...saved, showPushToTalk: false }))).not.toThrow();
  for (const field of ["savedShowPushToTalk", "defaultShowPushToTalk"])
    expect(() => parseState({ ...phone.state, [field]: true })).toThrow();
});

test("current traces reject retired offshoots across live state, shared groups and profile18", async () => {
  const { phone, post } = await fixture();
  const traces = { ...phone.state.design.traces, offshootPercent: 0 };
  expect(() => parseTraces(traces)).toThrow();
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, traces },
      })
    ).status,
  ).toBe(400);
  const saved = currentProfile(phone.state);
  expect(() =>
    parseProfile(JSON.stringify({ ...saved, design: { ...saved.design, traces } })),
  ).toThrow();
  expect(() =>
    parseProfile(
      JSON.stringify({
        ...saved,
        landscape: { ...saved.landscape, design: { ...saved.landscape.design, traces } },
      }),
    ),
  ).toThrow();
  expect(() =>
    parseProfile(
      JSON.stringify({
        ...saved,
        sharedAppearance: {
          ...saved.sharedAppearance,
          traces: { ...saved.sharedAppearance.traces, offshootPercent: 91 },
        },
      }),
    ),
  ).toThrow();
  for (const field of ["design", "savedDesign", "defaultDesign"])
    expect(() =>
      parseState({ ...phone.state, [field]: { ...phone.state.design, traces } }),
    ).toThrow();
  for (const field of ["sharedAppearance", "savedSharedAppearance", "defaultSharedAppearance"])
    expect(() =>
      parseState({
        ...phone.state,
        [field]: {
          ...phone.state.sharedAppearance,
          traces: { ...phone.state.sharedAppearance.traces, offshootPercent: 0 },
        },
      }),
    ).toThrow();
  expect(phone.calls).toHaveLength(0);
  expect(JSON.stringify(resetPreview(previewOf(phone.state), phone.state, "traces"))).not.toContain(
    "offshootPercent",
  );
});

test("legacy profile16 validates offshoots then removes them only from effective values while preserving sounds and flags", () => {
  const state = initial();
  state.sounds = { family: "rocker-13", volumePercent: 43 };
  const latest = currentProfile(state);
  const old = {
    ...latest,
    version: 16 as const,
    design: {
      ...versionSixteenDesign(latest.design),
      traces: { ...latest.design.traces, offshootPercent: 71 },
    },
    landscape: {
      ...latest.landscape,
      appearanceOverrides: ["traces"] as const,
      design: {
        ...versionSixteenDesign(latest.landscape.design),
        traces: { ...latest.landscape.design.traces, offshootPercent: 92 },
      },
    },
    sharedAppearance: {
      ...latest.sharedAppearance,
      traces: { ...latest.sharedAppearance.traces, offshootPercent: 37 },
    },
  };
  const bytes = JSON.stringify(old, null, 2);
  const loaded = parseProfile(bytes);
  expect(JSON.stringify(withoutThinkingWingspan(loaded), null, 2)).toBe(bytes);
  expect(profileDesign(loaded)).toEqual(state.design);
  expect(profileLayout(loaded, "portrait")).toEqual(layoutOf(state));
  expect(profileLayout(loaded, "landscape")).toEqual({
    ...state.otherLayout,
    appearanceOverrides: ["traces"],
  });
  expect(profileSharedAppearance(loaded)).toEqual(state.sharedAppearance);
  expect(profileSounds(loaded)).toEqual(state.sounds);
  for (const invalid of [-1, 101, 0.5, "70", undefined]) {
    expect(() =>
      parseProfile(
        JSON.stringify({
          ...old,
          design: { ...old.design, traces: { ...old.design.traces, offshootPercent: invalid } },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({
          ...old,
          landscape: {
            ...old.landscape,
            design: {
              ...old.landscape.design,
              traces: { ...old.landscape.design.traces, offshootPercent: invalid },
            },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({
          ...old,
          sharedAppearance: {
            ...old.sharedAppearance,
            traces: { ...old.sharedAppearance.traces, offshootPercent: invalid },
          },
        }),
      ),
    ).toThrow();
  }
  expect(JSON.stringify(withoutThinkingWingspan(loaded), null, 2)).toBe(bytes);
});

test("protocol21 and profile18 reject divergent current or saved spacing for every field", () => {
  const state = initial();
  const profile = currentProfile(state);
  for (const field of spacingFields) {
    const otherLayout = structuredClone(state.otherLayout);
    otherLayout.design.spacing[field]++;
    expect(() => parseState({ ...state, otherLayout })).toThrow("Mismatched shared spacing");
    expect(() => parseState({ ...state, savedOtherLayout: otherLayout })).toThrow(
      "Mismatched shared spacing",
    );
    expect(() =>
      parseProfile(JSON.stringify({ ...profile, landscape: withoutThinkingWingspan(otherLayout) })),
    ).toThrow("Mismatched shared spacing");
  }
  const otherLayout = structuredClone(state.otherLayout);
  otherLayout.design.spacing.paddingDp = 29;
  const unsaved = {
    ...state,
    design: { ...state.design, spacing: { ...otherLayout.design.spacing } },
    otherLayout,
    remainingLayouts: Object.fromEntries(
      Object.entries(state.remainingLayouts).map(([key, layout]) => [
        key,
        { ...layout, design: { ...layout.design, spacing: { ...otherLayout.design.spacing } } },
      ]),
    ) as PhoneState["remainingLayouts"],
  };
  expect(parseState(unsaved).design.spacing.paddingDp).toBe(29);
  expect(parseState(unsaved).savedDesign.spacing.paddingDp).toBe(16);
});

test("all spacing edits and resets update both orientations while keeping sizes, session and sounds", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.state.sounds = { family: "rocker-13", volumePercent: 46 };
  phone.state.showPushToTalk = false;
  const portrait = layoutOf(phone.state);
  const landscape = structuredClone(phone.state.otherLayout);
  const spacing = {
    paddingDp: -1,
    sideMarginPercent: 171,
    edgeClearancePercent: 42,
    sectionGapDp: 61,
    channelGapDp: 26,
    pushGapDp: 43,
  };
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        design: { ...phone.state.design, spacing },
      })
    ).status,
  ).toBe(200);
  expect(phone.state.otherLayout.design.spacing).toEqual(spacing);
  phone.rotate();
  expect(phone.state.design.spacing).toEqual(spacing);
  for (const field of spacingFields) {
    const next = resetPreview(previewOf(phone.state), phone.state, `spacing-${field}`);
    expect((await post("preview", next)).status).toBe(200);
    expect(phone.state.design.spacing[field]).toBe(defaultSpacing()[field]);
    expect(phone.state.otherLayout.design.spacing).toEqual(phone.state.design.spacing);
  }
  expect(phone.state.sounds).toEqual({ family: "rocker-13", volumePercent: 46 });
  expect(phone.state.showPushToTalk).toBe(false);
  expect(layoutOf(phone.state)).toEqual(landscape);
  expect(phone.state.otherLayout).toEqual(portrait);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(profileLayout(saved, "portrait").design.spacing).toEqual(defaultSpacing());
  expect(profileLayout(saved, "landscape").design.spacing).toEqual(defaultSpacing());
});

test("legacy profile16 keeps both raw spacing copies but normalizes all effective landscape spacing from portrait", () => {
  const latest = currentProfile(initial());
  const portraitSpacing = {
    paddingDp: -1,
    sideMarginPercent: 159,
    edgeClearancePercent: 63,
    sectionGapDp: 58,
    channelGapDp: 34,
    pushGapDp: 45,
  };
  const landscapeSpacing = {
    paddingDp: 31,
    sideMarginPercent: 27,
    edgeClearancePercent: 181,
    sectionGapDp: 14,
    channelGapDp: 3,
    pushGapDp: 7,
  };
  const old = {
    ...latest,
    version: 16 as const,
    design: { ...versionSixteenDesign(latest.design), spacing: portraitSpacing },
    landscape: {
      ...latest.landscape,
      design: { ...versionSixteenDesign(latest.landscape.design), spacing: landscapeSpacing },
    },
    sharedAppearance: {
      ...latest.sharedAppearance,
      traces: { ...latest.sharedAppearance.traces, offshootPercent: 0 },
    },
  };
  const bytes = JSON.stringify(old, null, 2);
  const parsed = parseProfile(bytes);
  expect(JSON.stringify(withoutThinkingWingspan(parsed), null, 2)).toBe(bytes);
  expect(profileLayout(parsed, "portrait").design.spacing).toEqual(portraitSpacing);
  expect(profileLayout(parsed, "landscape").design.spacing).toEqual(portraitSpacing);
  const changed = profileLayout(parsed, "landscape");
  changed.design.spacing.paddingDp = 38;
  expect(profileLayout(parsed, "portrait").design.spacing).toEqual(portraitSpacing);
  expect(profileLayout(parsed, "landscape").design.spacing).toEqual(portraitSpacing);
  expect(JSON.stringify(withoutThinkingWingspan(parsed), null, 2)).toBe(bytes);
});

test("both current control extents require integer160–1600 while profile17 keeps its strict old shape and limits", () => {
  const current = currentProfile(initial());
  const legacy = {
    ...current,
    version: 17 as const,
    design: versionSeventeenDesign(current.design),
    landscape: { ...current.landscape, design: versionSeventeenDesign(current.landscape.design) },
  };
  for (const field of ["controlsHeightDp", "controlsWithoutPttDp"] as const) {
    for (const value of [160, 239, 481, 900, 1600]) {
      const design = { ...current.design, [field]: value };
      expect(parseDesign(design)[field]).toBe(value);
      expect(profileDesign(parseProfile(JSON.stringify({ ...current, design })))[field]).toBe(
        value,
      );
    }
    for (const value of [undefined, null, 159, 1601, 300.5, "300", NaN, Infinity]) {
      const design = { ...current.design, [field]: value };
      expect(() => parsePreview({ ...previewOf(initial()), design })).toThrow();
      expect(() => parseState({ ...initial(), design })).toThrow();
      expect(() => parseProfile(JSON.stringify({ ...current, design }))).toThrow();
    }
  }
  for (const controlsHeightDp of [160, 239, 481, 1600])
    expect(() =>
      parseProfile(JSON.stringify({ ...legacy, design: { ...legacy.design, controlsHeightDp } })),
    ).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...legacy, design: current.design }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...legacy, landscape: current.landscape }))).toThrow();
});

test("legacy profile17 seeds each hidden extent from that orientation without changing raw bytes or other choices", () => {
  const current = currentProfile(initial());
  const legacy = {
    ...current,
    version: 17 as const,
    sounds: { family: "rocker-29" as const, volumePercent: 39 },
    design: {
      ...versionSeventeenDesign(current.design),
      controlsHeightDp: 389,
      holdSharePercent: 53,
    },
    landscape: {
      ...current.landscape,
      design: {
        ...versionSeventeenDesign(current.landscape.design),
        controlsHeightDp: 471,
        holdSharePercent: 37,
      },
    },
  };
  const bytes = JSON.stringify(legacy, null, 2);
  const parsed = parseProfile(bytes);
  expect(JSON.stringify(withoutThinkingWingspan(parsed), null, 2)).toBe(bytes);
  expect(profileLayout(parsed, "portrait").design).toEqual({
    ...legacy.design,
    controlsWithoutPttDp: 389,
  });
  expect(profileLayout(parsed, "landscape").design).toEqual({
    ...legacy.landscape.design,
    controlsWithoutPttDp: 471,
  });
  expect(profileSounds(parsed)).toEqual(legacy.sounds);
  expect(withoutThinkingWingspan(profileSharedAppearance(parsed))).toEqual(
    current.sharedAppearance,
  );
  expect(profileLayout(parsed, "portrait").appearanceOverrides).toEqual(
    current.appearanceOverrides,
  );
  expect(profileDesign(parsed).controlsWithoutPttDp).toBe(389);
  expect(JSON.stringify(withoutThinkingWingspan(parsed), null, 2)).toBe(bytes);
});

test("button-size resets change only the active extent and reset share only when push to talk is shown", () => {
  for (const orientation of ["portrait", "landscape"] as const) {
    const state = initial();
    state.orientation = orientation;
    state.defaultDesign =
      orientation === "portrait" ? defaultPortraitLayout().design : defaultLandscapeLayout().design;
    const selection = previewOf(state);
    selection.design.controlsHeightDp = 1210;
    selection.design.controlsWithoutPttDp = 730;
    selection.design.holdSharePercent = 57;
    selection.sounds = { family: "rocker-13", volumePercent: 42 };
    const shown = resetPreview(selection, state, "controls");
    expect(shown.design.controlsHeightDp).toBe(state.defaultDesign.controlsHeightDp);
    expect(shown.design.controlsWithoutPttDp).toBe(730);
    expect(shown.design.holdSharePercent).toBe(state.defaultDesign.holdSharePercent);
    selection.showPushToTalk = false;
    const hidden = resetPreview(selection, state, "controls");
    expect(hidden).toEqual({
      ...selection,
      design: {
        ...selection.design,
        controlsWithoutPttDp: state.defaultDesign.controlsWithoutPttDp,
      },
    });
    expect(hidden.design.controlsHeightDp).toBe(1210);
    expect(hidden.design.holdSharePercent).toBe(57);
  }
});

test("four saved extents remain independent across visibility changes and rotation", async () => {
  const { phone, post, saveTo } = await fixture();
  const update = async (showPushToTalk: boolean, extent: number) => {
    const selected = previewOf(phone.state);
    selected.showPushToTalk = showPushToTalk;
    selected.design[showPushToTalk ? "controlsHeightDp" : "controlsWithoutPttDp"] = extent;
    expect((await post("preview", selected)).status).toBe(200);
  };
  await update(true, 940);
  await update(false, 570);
  phone.rotate();
  await update(true, 1300);
  await update(false, 780);
  expect(phone.state.design.controlsHeightDp).toBe(1300);
  expect(phone.state.design.controlsWithoutPttDp).toBe(780);
  expect(phone.state.otherLayout.design.controlsHeightDp).toBe(940);
  expect(phone.state.otherLayout.design.controlsWithoutPttDp).toBe(570);
  phone.rotateDuringSave = true;
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileLayout(saved, "portrait").design.controlsHeightDp).toBe(940);
  expect(profileLayout(saved, "portrait").design.controlsWithoutPttDp).toBe(570);
  expect(profileLayout(saved, "landscape").design.controlsHeightDp).toBe(1300);
  expect(profileLayout(saved, "landscape").design.controlsWithoutPttDp).toBe(780);
  expect(profileVisualSettings(saved).showPushToTalk).toBe(phone.state.showPushToTalk);
});

test("a mismatched inactive hidden extent receipt cannot overwrite the host profile", async () => {
  const { phone, post, saveTo } = await fixture();
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const bytes = await readFile(saveTo, "utf8");
  phone.wrongHiddenExtentReceipt = true;
  expect((await post("save", { revision: phone.state.revision })).status).toBe(502);
  expect(await readFile(saveTo, "utf8")).toBe(bytes);
});

test("icon auditions validate exact independent session selections before dispatch", async () => {
  const { phone, post } = await fixture();
  for (const icons of [
    undefined,
    null,
    [],
    {},
    "current",
    { channels: "current" },
    { push: "current" },
    { channels: "current", push: "phosphor-bold" },
    { channels: "contact", push: "current" },
    { channels: "current", push: "contact", launcher: "duplex-halo" },
  ]) {
    expect(() => parsePreview({ ...previewOf(phone.state), icons })).toThrow();
    expect(() => parseState({ ...phone.state, icons })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), icons })).status).toBe(400);
  }
  expect(phone.calls).toHaveLength(0);
  for (const channels of iconStyles)
    for (const push of pushIconStyles) {
      const icons = { channels, push };
      expect((await post("preview", { ...previewOf(phone.state), icons })).status).toBe(200);
      expect(phone.state.icons).toEqual(icons);
      expect(pushIconPreview(icons).file).toBe(
        push === "microphone"
          ? iconCatalog[channels].channels[0]
          : push === "contact"
            ? "ptt-contact-monochrome.svg"
            : "current-push.svg",
      );
    }
  const count = phone.calls.length;
  expect(
    (await post("preview", { ...previewOf(phone.state), launcher: "../duplex-halo" })).status,
  ).toBe(400);
  expect(phone.calls).toHaveLength(count);
  for (const field of ["savedIcons", "defaultIcons", "launcher"])
    expect(() => parseState({ ...phone.state, [field]: defaultIcons() })).toThrow();
});

test("icon choices persist across rotation, hiding and Save with independent resets", async () => {
  const { phone, post, saveTo } = await fixture();
  const portrait = layoutOf(phone.state);
  const landscape = structuredClone(phone.state.otherLayout);
  const icons = { channels: "phosphor-bold", push: "microphone" } as const;
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        icons,
        showPushToTalk: false,
        mutedPresence: "off",
      })
    ).status,
  ).toBe(200);
  expect(layoutOf(phone.state)).toEqual(portrait);
  expect(phone.state.otherLayout).toEqual(landscape);
  phone.rotate();
  expect(phone.state.icons).toEqual(icons);
  const copied = previewOf(phone.state);
  copied.icons.channels = "engraved";
  expect(phone.state.icons).toEqual(icons);
  expect(resetPreview(previewOf(phone.state), phone.state, "channel-icons").icons).toEqual({
    channels: "current",
    push: "microphone",
  });
  expect(resetPreview(previewOf(phone.state), phone.state, "push-icon").icons).toEqual({
    channels: "phosphor-bold",
    push: "current",
  });
  for (const target of [
    "controls",
    "size",
    "position",
    "sounds",
    "spacing",
    "traces",
    "glow",
    "muted-appearance",
    "animation",
    "colors",
    "light",
    "spirit-colors",
  ] as const)
    expect(resetPreview(previewOf(phone.state), phone.state, target).icons).toEqual(icons);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileVisualSettings(saved).icons).toEqual(icons);
  expect(profileVisualSettings(saved).launcher).toBe("current");
  expect(phone.state.icons).toEqual(icons);
  expect(profileLayout(saved, "portrait")).toEqual(portrait);
  expect(profileLayout(saved, "landscape")).toEqual(landscape);
  if (saved.version !== 23) throw Error("Expected current profile");
  expect(() => parseProfile(JSON.stringify({ ...saved, icons }))).not.toThrow();
  expect(() =>
    parseProfile(JSON.stringify({ ...saved, landscape: { ...saved.landscape, icons } })),
  ).toThrow();
  expect(() =>
    parseProfile(
      JSON.stringify({ ...saved, sharedAppearance: { ...saved.sharedAppearance, icons } }),
    ),
  ).toThrow();
});

test("icon and launcher previews serve only catalog assets with fixed safe credits and self-only images", async () => {
  const { phone, url } = await fixture();
  for (const file of iconPreviewFiles()) {
    expect(file).toMatch(/^[a-z0-9-]+\.svg$/);
    const response = await fetch(new URL(`icon-previews/${file}`, url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    expect(svg).toMatch(/<title(?:\s[^>]*)?>[^<]+<\/title>/);
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
    expect(root).toContain('role="img"');
    expect(root).toMatch(/aria-label(?:ledby)?="[^"]+"/);
    expect(svg).not.toMatch(
      /<script|<foreignObject|\bon\w+=|(?:href|src)=["'](?:https?:|data:|javascript:)/i,
    );
  }
  for (const path of [
    "icon-previews/nope.svg",
    "icon-previews/../README.md",
    "icon-previews/%2e%2e%2fREADME.md",
    "icon-previews/hand-tap-bold.svg",
    "icon-previews/PHOSPHOR-LICENSE.txt/nope",
  ])
    expect((await fetch(new URL(path, url))).status).toBe(404);
  const license = await fetch(new URL("icon-previews/PHOSPHOR-LICENSE.txt", url));
  expect(license.status).toBe(200);
  expect(await license.text()).toContain("MIT License");
  for (const entry of Object.values(iconCatalog)) {
    for (const value of [entry.credit.source, entry.credit.license])
      if (value) expect(safeCreditLink(value)).toBe(value);
  }
  for (const value of [
    "javascript:alert(1)",
    "https://example.com",
    "//github.com/phosphor-icons",
    "https://github.com.evil.test/",
    "/state",
  ])
    expect(() => safeCreditLink(value)).toThrow();
  expect(launcherConcepts.map((entry) => entry.id)).toEqual([
    "current",
    "duplex-halo",
    "relay-aperture",
    "voice-carrier",
  ]);
  expect(phone.calls).toHaveLength(0);
});

test("credits on phone is a fenced one-shot command without preview or profile mutation", async () => {
  const { phone, post, saveTo } = await fixture();
  const before = structuredClone(phone.state);
  expect((await post("icon-credits", {})).status).toBe(200);
  expect(phone.calls).toEqual([{ method: "iconCredits" }]);
  expect(phone.state).toEqual(before);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  for (const body of [
    { revision: 0 },
    { icons: defaultIcons() },
    { generation: null },
    { orientationEpoch: -1 },
  ])
    expect((await post("icon-credits", body)).status).toBe(400);
  expect((await post("icon-credits", {}, { Origin: "https://example.com" })).status).toBe(403);
  expect((await post("icon-credits", { generation: phone.generation + 1 })).status).toBe(409);
  expect(
    (await post("icon-credits", { orientationEpoch: phone.state.orientationEpoch + 1 })).status,
  ).toBe(409);
  phone.connected = false;
  expect((await post("icon-credits", {})).status).toBe(503);
  expect(phone.calls).toEqual([{ method: "iconCredits" }]);
});

test("unconfirmed phone credits fail once without Save or automatic replay", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.request = async (command) => {
    phone.calls.push(command);
    throw Error("Disconnected before credits confirmation");
  };
  expect((await post("icon-credits", {})).status).toBe(502);
  expect(phone.calls).toEqual([{ method: "iconCredits" }]);
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("connection rehearsal is a strict transient command with orientation and generation fences", async () => {
  const { phone, post, saveTo } = await fixture();
  const before = structuredClone(phone.state);
  expect((await post("connection-preview", { scene: "permission" })).status).toBe(200);
  expect(phone.calls).toEqual([
    {
      method: "connectionPreview",
      scene: "permission",
      orientation: before.orientation,
      orientationEpoch: before.orientationEpoch,
    },
  ]);
  expect(phone.state).toEqual(before);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  for (const body of [
    { scene: "saveGrant" },
    { scene: "camera", token: "secret" },
    {},
    { scene: null },
  ])
    expect((await post("connection-preview", body)).status).toBe(400);
  expect(
    (await post("connection-preview", { scene: "camera", generation: phone.generation + 1 }))
      .status,
  ).toBe(409);
  expect(
    (
      await post("connection-preview", {
        scene: "camera",
        orientationEpoch: before.orientationEpoch + 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (await post("connection-preview", { scene: "camera" }, { Origin: "https://example.com" }))
      .status,
  ).toBe(403);
  expect(phone.calls).toHaveLength(1);
  expect(() => parseState({ ...before, connectionPreview: "saveGrant" })).toThrow();
  expect(() => parseState({ ...before, protocol: 24 })).toThrow();
});

test("protocol 30 widens only its transient connection rehearsal scenes", async () => {
  const { phone, post, saveTo } = await fixture();
  const before = structuredClone(phone.state);
  expect(parseState(before).connectionPreview).toBe("off");
  for (const scene of [
    "root-unpaired",
    "root-pairing-pending",
    "root-disconnected",
    "root-connecting",
    "root-active",
    "root-failed",
  ] as const) {
    expect(parseState({ ...before, connectionPreview: scene }).connectionPreview).toBe(scene);
    expect((await post("connection-preview", { scene })).status).toBe(200);
  }
  expect(phone.calls.map((call) => call["scene"])).toEqual([
    "root-unpaired",
    "root-pairing-pending",
    "root-disconnected",
    "root-connecting",
    "root-active",
    "root-failed",
  ]);
  expect(phone.state).toEqual(before);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect(() => parseState({ ...before, connectionPreview: "root-connected" })).toThrow();
});

test("an older phone bridge rejects a new root rehearsal visibly and without retry", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.request = async (command) => {
    phone.calls.push(command);
    throw Error("Phone rejected widened protocol 30 rehearsal");
  };
  const response = await post("connection-preview", { scene: "root-active" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Phone rejected widened protocol 30 rehearsal" });
  expect(phone.calls).toEqual([
    {
      method: "connectionPreview",
      scene: "root-active",
      orientation: phone.state.orientation,
      orientationEpoch: phone.state.orientationEpoch,
    },
  ]);
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("cleared Noun pairs expose exact attribution and matching-mic credits without widening safe links", () => {
  for (const [id, author, mic, speaker, name] of [
    ["noun-boatman", "Edward Boatman", "microphone-171", "speaker-100", "Speaker"],
    ["noun-icons", "i cons", "microphone-856601", "volume-974802", "Volume"],
  ] as const) {
    const pair = iconCatalog[id];
    expect(pair.credit.author).toBe(`Microphone and ${name} by ${author} from Noun Project`);
    expect(pair.credit.tag).toBe("CC BY 3.0");
    expect(pair.credit.license).toBe("https://creativecommons.org/licenses/by/3.0/");
    expect(pair.credit.sources?.map((source) => safeCreditLink(source.url))).toEqual([
      `https://thenounproject.com/icon/${mic}/`,
      `https://thenounproject.com/icon/${speaker}/`,
      "https://thenounproject.com/browse/icons/term/microphone/",
      `https://thenounproject.com/browse/icons/term/${name === "Speaker" ? "speaker" : "volume"}/`,
    ]);
    expect(pair.credit.changes).toContain("mute slashes added");
    expect(pair.credit.changes?.includes("Three isolated lower wave fragments removed")).toBe(
      id === "noun-boatman",
    );
    const push = pushIconPreview({ channels: id, push: "microphone" });
    expect(push.credit.author).toBe(`Microphone by ${author} from Noun Project`);
    expect(push.credit.sources).toEqual([
      { label: "Microphone source", url: `https://thenounproject.com/icon/${mic}/` },
      {
        label: "Noun Project · Microphone",
        url: "https://thenounproject.com/browse/icons/term/microphone/",
      },
    ]);
    expect(push.credit.tag).toBe("CC BY 3.0");
    expect(push.credit.changes).not.toContain("mute slashes");
    expect(push.file).toBe(pair.channels[0]);
  }
  for (const source of [
    "https://thenounproject.com/icon/microphone-172/",
    "https://thenounproject.com.evil.test/icon/microphone-171/",
    "https://creativecommons.org/licenses/by/4.0/",
  ])
    expect(() => safeCreditLink(source)).toThrow();
});

test("preview asset directory contains only catalog artwork and Phosphor differs only in accessibility metadata", async () => {
  const directory = new URL("../public/icon-previews/", import.meta.url);
  expect((await readdir(directory)).filter((file) => file.endsWith(".svg")).sort()).toEqual(
    iconPreviewFiles().sort(),
  );
  const removeAccessibility = (svg: string) =>
    svg
      .replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/g, "")
      .replace(/<svg\b[^>]*>/, (root) =>
        root.replace(/ (?:role|aria-label|aria-labelledby)="[^"]*"/g, ""),
      );
  for (const family of ["phosphor-bold", "phosphor-fill"] as const) {
    for (const filename of iconCatalog[family].channels) {
      const preview = await readFile(new URL(filename, directory), "utf8");
      const original = await readFile(
        new URL(`../../third-party/icons/phosphor/${filename}`, import.meta.url),
        "utf8",
      );
      expect(removeAccessibility(preview)).toBe(removeAccessibility(original));
    }
  }
});

test("profile19 and protocol22 require every saved appearance field while legacy18 retains exact bytes", async () => {
  const { phone, post, saveTo } = await fixture();
  const legacy = JSON.stringify(currentProfile(phone.state));
  const selected = {
    ...defaultVisualSettings(),
    icons: { channels: "noun-icons" as const, push: "contact" as const },
    theme: "quiet" as const,
    mutedPresence: "contacts" as const,
    presenceScope: "always" as const,
    mutedTuning: {
      ...defaultVisualSettings().mutedTuning,
      textSizeSp: 32,
      brightnessPercent: -19,
      driftPercent: 196,
      breathPercent: 100,
      cycleSeconds: 13,
      motion: "ripple" as const,
    },
    showPushToTalk: false,
  };
  for (const [field, value] of Object.entries(selected)) {
    expect(() => parseProfile(JSON.stringify({ ...JSON.parse(legacy), [field]: value }))).toThrow();
    for (const appearanceField of ["savedAppearance", "defaultAppearance"]) {
      const missing = { ...selected } as Record<string, unknown>;
      delete missing[field];
      expect(() => parseState({ ...phone.state, [appearanceField]: missing })).toThrow();
    }
  }
  expectLegacyProfile(parseProfile(legacy), JSON.parse(legacy));
  expect((await post("preview", { ...previewOf(phone.state), ...selected })).status).toBe(200);
  expect(equalVisualSettings(phone.state, phone.state.savedAppearance)).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const bytes = await readFile(saveTo, "utf8");
  const saved = parseProfile(bytes);
  expect(saved.version).toBe(23);
  expect(profileVisualSettings(saved)).toEqual(selected);
  expect(phone.state.savedAppearance).toEqual(selected);
  for (const field of Object.keys(selected)) {
    const incomplete = JSON.parse(bytes);
    delete incomplete[field];
    expect(() => parseProfile(JSON.stringify(incomplete))).toThrow();
  }
  for (const field of [
    "mode",
    "connection",
    "activity",
    "holding",
    "micMuted",
    "speakerMuted",
    "launcher",
  ])
    expect(() => parseProfile(JSON.stringify({ ...saved, [field]: "runtime" }))).toThrow();
});

test("Save validates every adopted appearance value before replacing a host profile", async () => {
  const variants = [
    { launcher: "relay-aperture" },
    { icons: { channels: "noun-icons", push: "contact" } },
    { theme: "quiet" },
    { mutedPresence: "off" },
    { presenceScope: "always" },
    { showPushToTalk: false },
    { mutedTuning: { ...defaultVisualSettings().mutedTuning, brightnessPercent: -19 } },
  ];
  for (const patch of variants) {
    const { phone, post, saveTo } = await fixture();
    expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
    const before = await readFile(saveTo, "utf8");
    const request = phone.request.bind(phone);
    phone.request = async (command) => {
      const reply = await request(command);
      return reply.profile
        ? { ...reply, profile: JSON.stringify({ ...JSON.parse(reply.profile), ...patch }) }
        : reply;
    };
    expect((await post("save", { revision: phone.state.revision })).status).toBe(502);
    expect(await readFile(saveTo, "utf8")).toBe(before);
  }
});

test("appearance resets use promoted defaults and preserve geometry and sounds", () => {
  const state = initial();
  state.defaultAppearance = {
    ...defaultVisualSettings(),
    icons: { channels: "noun-icons", push: "microphone" },
    mutedTuning: {
      ...defaultVisualSettings().mutedTuning,
      textSizeSp: 32,
      brightnessPercent: -19,
      motion: "ripple",
    },
  };
  const original = previewOf(state);
  expect(resetPreview(original, state, "channel-icons").icons.channels).toBe("noun-icons");
  expect(resetPreview(original, state, "push-icon").icons.push).toBe("microphone");
  expect(resetPreview(original, state, "muted-textSizeSp").mutedTuning.textSizeSp).toBe(32);
  const reset = resetPreview(original, state, "visual-settings");
  expect(visualSettingsOf(reset)).toEqual(state.defaultAppearance);
  expect(layoutOf(reset)).toEqual(layoutOf(original));
  expect(reset.sounds).toEqual(original.sounds);
});

test("launcher selection is strict, shared and durable in profile20 with adopted reset defaults", async () => {
  const { phone, post, saveTo } = await fixture();
  const layout = layoutOf(phone.state);
  const icons = { ...phone.state.icons };
  for (const launcher of [undefined, null, "", "experimental", "../relay-aperture", {}, 1]) {
    expect(() => parseState({ ...phone.state, launcher })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), launcher })).status).toBe(400);
    expect(() =>
      parseState({ ...phone.state, savedAppearance: { ...phone.state.savedAppearance, launcher } }),
    ).toThrow();
    expect(() =>
      parseState({
        ...phone.state,
        defaultAppearance: { ...phone.state.defaultAppearance, launcher },
      }),
    ).toThrow();
  }
  expect(phone.calls).toHaveLength(0);
  for (const launcher of ["current", "duplex-halo", "relay-aperture", "voice-carrier"] as const) {
    expect((await post("preview", { ...previewOf(phone.state), launcher })).status).toBe(200);
    expect(phone.state.launcher).toBe(launcher);
  }
  expect(layoutOf(phone.state)).toEqual(layout);
  expect(phone.state.icons).toEqual(icons);
  expect(
    (await post("preview", { ...previewOf(phone.state), launcher: "relay-aperture" })).status,
  ).toBe(200);
  expect(equalVisualSettings(phone.state, phone.state.savedAppearance)).toBe(false);
  phone.rotate();
  expect(phone.state.launcher).toBe("relay-aperture");
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileVisualSettings(saved).launcher).toBe("relay-aperture");
  expect(phone.state.savedAppearance.launcher).toBe("relay-aperture");
  phone.state.defaultAppearance.launcher = "duplex-halo";
  const reset = resetPreview(previewOf(phone.state), phone.state, "launcher");
  expect(reset.launcher).toBe("duplex-halo");
  expect(reset.icons).toEqual(icons);
  expect(layoutOf(reset)).toEqual(layoutOf(phone.state));
});

test("connection display is strict, shared across all layouts and complete in profile22", async () => {
  const { phone, post, saveTo } = await fixture();
  for (const connectionStyle of [undefined, null, "", "tower", {}, 1]) {
    expect(() => parseState({ ...phone.state, connectionStyle })).toThrow();
    expect((await post("preview", { ...previewOf(phone.state), connectionStyle })).status).toBe(
      400,
    );
  }
  expect(
    (
      await post("preview", {
        ...previewOf(phone.state),
        connectionStyle: "datum",
        connection: "failed",
      })
    ).status,
  ).toBe(200);
  expect(phone.state.connectionStyle).toBe("datum");
  expect(phone.state.connection).toBe("failed");
  phone.rotate();
  expect(phone.state.connectionStyle).toBe("datum");
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(23);
  expect(profileVisualSettings(saved).connectionStyle).toBe("datum");
  expect(saved).not.toHaveProperty("connection");

  phone.wrongConnectionStyleReceipt = true;
  await post("preview", { ...previewOf(phone.state), connectionStyle: "beacon" });
  expect((await post("save", { revision: phone.state.revision })).status).toBe(502);
  expect(profileVisualSettings(parseProfile(await readFile(saveTo, "utf8"))).connectionStyle).toBe(
    "datum",
  );

  const legacy = withoutThinkingWingspan({
    ...(saved as Extract<Profile, { version: 23 }>),
    version: 21 as const,
  }) as Record<string, unknown>;
  delete legacy["connectionStyle"];
  const legacyText = JSON.stringify(legacy);
  expect(JSON.stringify(withoutThinkingWingspan(parseProfile(legacyText)))).toBe(legacyText);
  expect(profileVisualSettings(parseProfile(legacyText)).connectionStyle).toBe("relay");
});

test("legacy profile19 retains its exact field contract and defaults newer choices only in memory", () => {
  const { launcher: _, connectionStyle: __, ...legacyAppearance } = defaultVisualSettings();
  const source = { ...currentProfile(initial()), version: 19 as const, ...legacyAppearance };
  const text = JSON.stringify(source);
  const profile = parseProfile(text);
  expect(profile).not.toHaveProperty("launcher");
  expect(profileVisualSettings(profile).launcher).toBe("current");
  expectLegacyProfile(profile, source);
  expect(() => parseProfile(JSON.stringify({ ...source, launcher: "current" }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...source, version: 20 }))).toThrow();
  const complete = parseProfile(
    JSON.stringify({ ...source, version: 20, launcher: "relay-aperture" }),
  );
  expect(profileVisualSettings(complete).launcher).toBe("relay-aperture");
  expect(profileVisualSettings(complete).connectionStyle).toBe("relay");
});

test("production reset is revision/orientation/generation fenced and never exports over the saved profile", async () => {
  const { phone, post, saveTo } = await fixture();
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const checkpoint = await readFile(saveTo, "utf8");
  phone.calls = [];
  expect((await post("reset-production", { revision: phone.state.revision + 1 })).status).toBe(409);
  expect(
    (await post("reset-production", { revision: phone.state.revision, orientationEpoch: 99 }))
      .status,
  ).toBe(409);
  expect(
    (await post("reset-production", { revision: phone.state.revision, generation: 99 })).status,
  ).toBe(409);
  expect(phone.calls).toHaveLength(0);
  expect((await post("reset-production", { revision: phone.state.revision })).status).toBe(200);
  expect(phone.calls[0]).toEqual({
    method: "resetProduction",
    revision: phone.state.revision,
    orientation: phone.state.orientation,
    orientationEpoch: phone.state.orientationEpoch,
  });
  expect(await readFile(saveTo, "utf8")).toBe(checkpoint);
});
