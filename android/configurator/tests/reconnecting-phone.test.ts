import { afterEach, expect, test } from "bun:test";
import { defaultDesign } from "../src/design.ts";
import { defaultHalo } from "../src/halo.ts";
import { defaultMutedTuning } from "../src/muted-presence.ts";
import {
  defaultLandscapeLayout,
  defaultPortraitLayout,
  defaultSharedAppearance,
  defaultVisualSettings,
  type PhoneState,
} from "../src/protocol.ts";
import { type PreviewConnection, ReconnectingPhone } from "../src/reconnecting-phone.ts";
import { defaultSounds } from "../src/sounds.ts";
import { defaultSpirit } from "../src/spirit.ts";
import { defaultTraces } from "../src/traces.ts";

const scales = { speaking: 78, listening: 58, idle: 78 };
const timing = { poll: 5, retry: 10, maxRetry: 20 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

class Connection implements PreviewConnection {
  connected = true;
  state: PhoneState = {
    protocol: 29,
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
    appearanceOverrides: ["glow", "halo", "spirit", "traces"],
    savedAppearanceOverrides: [],
    sharedAppearance: defaultSharedAppearance(),
    savedSharedAppearance: defaultSharedAppearance(),
    defaultSharedAppearance: defaultSharedAppearance(),
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
    activity: "voice",
    connection: "connecting",
    revision: 0,
    holding: false,
    mode: "listening",
    scales: { ...scales, listening: 52 },
    savedScales: { ...scales },
    defaults: { ...scales },
    verticalOffsetDp: -24,
    savedVerticalOffsetDp: 35,
    defaultVerticalOffsetDp: 35,
    design: {
      ...structuredClone(defaultDesign),
      hold: "rocker",
      composition: "traces",
      traces: {
        ...defaultTraces(),
        pattern: "circuit",
        personaSpacingPercent: 75,
        footSpacingPercent: 155,
        stancePercent: 140,
        weightPercent: 180,
        glowPercent: 27,
      },
      controlsHeightDp: 380,
      holdSharePercent: 54.3,
    },
    savedDesign: structuredClone(defaultDesign),
    defaultDesign: structuredClone(defaultDesign),
    halo: { ...defaultHalo(), variant: "contained", containedSizePercent: 83 },
    savedHalo: defaultHalo(),
    defaultHalo: defaultHalo(),
    spirit: { surface: "soft", strengthPercent: 61, persona: "follow" },
    savedSpirit: defaultSpirit(),
    defaultSpirit: defaultSpirit(),
    micMuted: false,
    speakerMuted: false,
  };
  calls: Record<string, unknown>[] = [];
  close() {
    this.connected = false;
  }
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (!this.connected) throw Error("Disconnected");
    if (command["method"] === "save") {
      this.close();
      throw Error("Disconnected before save confirmation");
    }
    return { state: this.state };
  }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Timed out waiting for reconnect");
    await Bun.sleep(5);
  }
}

test("reconnect retains last preview, retries failed dials, then observes fresh state", async () => {
  const initial = new Connection();
  const returned = new Connection();
  const returnedTraces = {
    ...defaultTraces(),
    reachDp: 36,
    fadeLengthDp: 41,
    tipOpacityPercent: 57,
    pattern: "splayed" as const,
    personaSpacingPercent: 185,
    footSpacingPercent: 65,
    stancePercent: 93,
    weightPercent: 225,
    glowPercent: 54,
  };
  returned.state = {
    ...returned.state,
    icons: { channels: "engraved", push: "contact" },
    showPushToTalk: false,
    sounds: { family: "rocker-13", volumePercent: 43 },
    mode: "idle",
    mutedTuning: { ...defaultMutedTuning(), textSizeSp: 23, motion: "ripple", driftPercent: 250 },
    theme: "grayscale",
    mutedPresence: "contacts",
    presenceScope: "always",
    orientation: "landscape",
    orientationEpoch: 3,
    personaSide: "right",
    otherLayout: { ...defaultLandscapeLayout(), verticalOffsetDp: -96 },
    revision: 4,
    design: { ...returned.state.design, traces: returnedTraces },
  };
  let dials = 0;
  const phone = new ReconnectingPhone(
    initial,
    async () => {
      if (++dials < 3) throw Error("Device unavailable");
      return returned;
    },
    timing,
  );
  cleanups.push(() => phone.close());
  initial.close();
  expect(phone.connected).toBe(false);
  expect(phone.reconnecting).toBe(true);
  expect(phone.state.scales.listening).toBe(52);
  expect(phone.state.savedScales.listening).toBe(58);
  expect(phone.state.verticalOffsetDp).toBe(-24);
  expect(phone.state.design.controlsHeightDp).toBe(380);
  expect(phone.state.design.hold).toBe("rocker");
  expect(phone.state.design.composition).toBe("traces");
  expect(phone.state.design.traces).toEqual(initial.state.design.traces);
  expect(phone.state.design.holdSharePercent).toBe(54.3);
  expect(phone.state.connection).toBe("connecting");
  expect(phone.state.halo.containedSizePercent).toBe(83);
  expect(phone.state.activity).toBe("voice");
  expect(phone.state.spirit).toEqual({ surface: "soft", strengthPercent: 61, persona: "follow" });
  await until(() => phone.connected);
  expect(dials).toBe(3);
  expect(phone.generation).toBe(2);
  expect(phone.reconnecting).toBe(false);
  expect(phone.state.mode).toBe("idle");
  expect(phone.state.sounds).toEqual({ family: "rocker-13", volumePercent: 43 });
  expect(phone.state.showPushToTalk).toBe(false);
  expect(phone.state.icons).toEqual({ channels: "engraved", push: "contact" });
  expect(phone.state.mutedTuning).toEqual({
    ...defaultMutedTuning(),
    textSizeSp: 23,
    motion: "ripple",
    driftPercent: 250,
  });
  expect(phone.state.theme).toBe("grayscale");
  expect(phone.state.mutedPresence).toBe("contacts");
  expect(phone.state.presenceScope).toBe("always");
  expect(phone.state.orientation).toBe("landscape");
  expect(phone.state.orientationEpoch).toBe(3);
  expect(phone.state.personaSide).toBe("right");
  expect(phone.state.otherLayout.verticalOffsetDp).toBe(-96);
  expect(phone.state.design.traces).toEqual(returnedTraces);
  expect(initial.state.design.traces).not.toEqual(returnedTraces);
  expect(phone.state.halo.variant).toBe("contained");
  expect(phone.state.halo.containedSizePercent).toBe(83);
  expect(phone.state.verticalOffsetDp).toBe(-24);
  await until(() => returned.calls.length > 0);
  expect(phone.state.design.traces).toEqual(returnedTraces);
  expect(initial.calls.every((call) => call["method"] === "get")).toBe(true);
  expect(returned.calls.every((call) => call["method"] === "get")).toBe(true);
});

test("an unconfirmed save fails once and is never replayed after reconnect", async () => {
  const initial = new Connection();
  const returned = new Connection();
  const phone = new ReconnectingPhone(initial, async () => returned, timing);
  cleanups.push(() => phone.close());
  await expect(phone.request({ method: "save", revision: 0 })).rejects.toThrow("confirmation");
  await expect(phone.request({ method: "preview" })).rejects.toThrow("disconnected");
  await until(() => phone.generation === 2 && returned.calls.length > 0);
  expect(initial.calls).toEqual([{ method: "save", revision: 0 }]);
  expect(returned.calls.every((call) => call["method"] === "get")).toBe(true);
});

test("shutdown aborts an in-progress dial and closes even a late successful candidate", async () => {
  const initial = new Connection();
  const candidate = new Connection();
  let finish!: (connection: Connection) => void;
  let signal: AbortSignal | undefined;
  let dials = 0;
  const phone = new ReconnectingPhone(
    initial,
    (nextSignal) => {
      dials++;
      signal = nextSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    timing,
  );
  initial.close();
  await until(() => signal !== undefined);
  const closed = phone.close();
  expect(signal?.aborted).toBe(true);
  finish(candidate);
  await closed;
  await Bun.sleep(30);
  expect(dials).toBe(1);
  expect(candidate.connected).toBe(false);
  expect(phone.connected).toBe(false);
  expect(phone.reconnecting).toBe(false);
  expect(phone.generation).toBe(1);
});
