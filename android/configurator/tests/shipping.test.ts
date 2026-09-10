import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultVisualSettings } from "../src/protocol.ts";
import {
  canonicalJson,
  createShippingSnapshot,
  generateKotlin,
  kotlinString,
  parseShippingSnapshot,
  sha256,
  shippingCli,
  shippingOutputs,
  writeShipping,
} from "../src/shipping.ts";

const profileText = await readFile(
  new URL("./fixtures/shipping-profile18.json", import.meta.url),
  "utf8",
);
const session = {
  ...defaultVisualSettings(),
  icons: { channels: "noun-icons" as const, push: "current" as const },
  mutedTuning: {
    textSizeSp: 32,
    brightnessPercent: -19,
    driftPercent: 196,
    breathPercent: 100,
    cycleSeconds: 13,
    motion: "ripple" as const,
  },
};
const snapshot = () =>
  createShippingSnapshot(profileText, "saved-profile.json", {
    kind: "file",
    path: "session.json",
    text: JSON.stringify(session),
  });
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentvoice-shipping-"));
  cleanup.push(root);
  const input = join(root, "saved.json");
  const selection = join(root, "session.json");
  await writeFile(input, profileText);
  await writeFile(selection, JSON.stringify(session));
  return { root, input, selection };
}

test("locked shipping snapshot captures both effective orientations, exact source bytes and adopted session", () => {
  const value = snapshot();
  expect(value.source.profile.text).toBe(profileText);
  expect(value.source.profile.sha256).toBe(sha256(profileText));
  expect(value.portrait.design.controlsHeightDp).toBe(396);
  expect(value.landscape.design.controlsHeightDp).toBe(365);
  expect(value.portrait.verticalOffsetDp).toBe(-30);
  expect(value.landscape.horizontalOffsetDp).toBe(-16);
  expect(value.sounds).toEqual({ family: "rocker-13", volumePercent: 60 });
  expect(value.appearance).toEqual(session);
  expect(parseShippingSnapshot(canonicalJson(value))).toEqual(value);
  const generated = generateKotlin(value);
  expect(generated).toContain('channels = "noun-icons"');
  expect(generated).toContain("textSizeSp = 32");
  expect(generated).toContain('motion = "ripple"');
  expect(generated.match(/const val launcher/g)).toHaveLength(1);
  expect(generated).toContain('const val launcher = "current"');
  expect(generated).not.toContain("decodePreview");
  expect(generated).not.toContain("JSONObject");
});

test("legacy promotion requires explicit session source while profile19 carries its saved appearance", () => {
  expect(() => createShippingSnapshot(profileText, "old.json", { kind: "profile" })).toThrow(
    "needs --session",
  );
  expect(createShippingSnapshot(profileText, "old.json", { kind: "defaults" }).appearance).toEqual(
    defaultVisualSettings(),
  );
  const complete = { ...JSON.parse(profileText), version: 20, ...session };
  expect(
    createShippingSnapshot(JSON.stringify(complete), "complete.json", { kind: "profile" })
      .appearance,
  ).toEqual(session);
  expect(() =>
    createShippingSnapshot(
      JSON.stringify({ ...complete, connection: "connected" }),
      "invalid.json",
      { kind: "profile" },
    ),
  ).toThrow();
  expect(() =>
    createShippingSnapshot(profileText, "old.json", {
      kind: "file",
      path: "session.json",
      text: JSON.stringify({ ...session, holding: true }),
    }),
  ).toThrow();
});

test("live capture promotion requires saved-layout and sound parity and excludes runtime call fields", () => {
  const base = snapshot();
  const state = {
    ...base.portrait,
    ...session,
    protocol: 21,
    revision: 819,
    orientation: "portrait",
    otherLayout: base.landscape,
    sounds: base.sounds,
    holding: true,
    connection: "connected",
    activity: "voice",
    mode: "listening",
    micOpen: true,
  };
  const captured = (value: unknown) =>
    createShippingSnapshot(profileText, "saved.json", {
      kind: "live",
      path: "capture.json",
      text: JSON.stringify({ state: value }),
    });
  const selected = captured(state);
  expect(selected.appearance).toEqual(session);
  expect(canonicalJson(selected)).not.toContain('"holding"');
  expect(canonicalJson(selected)).not.toContain('"micOpen"');
  expect(() => captured({ ...state, horizontalOffsetDp: 1 })).toThrow("differ");
  expect(() =>
    captured({ ...state, otherLayout: { ...state.otherLayout, verticalOffsetDp: 9 } }),
  ).toThrow("differ");
  expect(() => captured({ ...state, sounds: { family: "off", volumePercent: 60 } })).toThrow(
    "differ",
  );
});

test("snapshot parsing rejects modified source, provenance and effective design", () => {
  const value = snapshot();
  for (const changed of [
    {
      ...value,
      source: { ...value.source, profile: { ...value.source.profile, text: `${profileText} ` } },
    },
    { ...value, appearance: { ...value.appearance, theme: "quiet" } },
    { ...value, portrait: { ...value.portrait, verticalOffsetDp: 1 } },
    { ...value, source: { ...value.source, session: { ...value.source.session, sha256: "bad" } } },
    { ...value, launcher: "experimental" },
  ])
    expect(() => parseShippingSnapshot(JSON.stringify(changed))).toThrow();
});

test("Kotlin provenance string escaping cannot create interpolation or source statements", () => {
  expect(kotlinString('x"\\\n\r\t$evil\u000c')).toBe(
    '"x\\"\\\\\\u000a\\u000d\\u0009\\$evil\\u000c"',
  );
  const value = createShippingSnapshot(profileText, 'profile"\n} $exec //', {
    kind: "file",
    path: "selected.json",
    text: JSON.stringify(session),
  });
  const code = generateKotlin(value);
  expect(code).toContain('profile\\"\\u000a} \\$exec //');
  expect(code).not.toContain('profile"\n}');
});

test("promotion and regeneration are deterministic, check never writes, and sources remain unchanged", async () => {
  const { root, input, selection } = await fixture();
  await shippingCli(["promote", "--profile", input, "--session", selection, "--root", root]);
  const canonical = join(root, "android/design/shipping-profile.json");
  const codePath = join(root, "android/app/src/main/java/com/arthack/agentvoice/ShippingDesign.kt");
  const code = await readFile(codePath, "utf8");
  const bytes = await readFile(canonical, "utf8");
  await shippingCli(["generate", "--check", "--root", root]);
  await shippingCli(["generate", "--root", root]);
  expect(await readFile(codePath, "utf8")).toBe(code);
  expect(await readFile(canonical, "utf8")).toBe(bytes);
  await writeFile(canonical, JSON.stringify({ ...JSON.parse(bytes), savedAtEpochMs: Date.now() }));
  await shippingCli(["generate", "--check", "--root", root]);
  await writeFile(codePath, "stale");
  await expect(shippingCli(["generate", "--check", "--root", root])).rejects.toThrow("stale");
  expect(await readFile(codePath, "utf8")).toBe("stale");
  expect(await readFile(input, "utf8")).toBe(profileText);
  expect(await readFile(selection, "utf8")).toBe(JSON.stringify(session));
});

test("release inventory contains only adopted artwork and sounds, and re-promotion removes owned stale assets", async () => {
  const { root } = await fixture();
  const first = snapshot();
  await writeShipping(first, { root, snapshot: true });
  const outputs = await shippingOutputs(first);
  expect([...outputs.keys()].filter((path) => path.endsWith(".wav"))).toHaveLength(4);
  expect(
    [...outputs.keys()].filter(
      (path) => path.includes("shipping_channel_") && path.endsWith(".xml"),
    ),
  ).toHaveLength(4);
  expect([...outputs.keys()].some((path) => path.includes("rocker-29"))).toBe(false);
  expect(
    String(outputs.get("android/app/src/main/assets/notices/Shipping-Icons-NOTICE.txt")),
  ).toContain("i cons from Noun Project");
  const silentProfile = JSON.stringify({
    ...JSON.parse(profileText),
    sounds: { family: "off", volumePercent: 60 },
  });
  const next = createShippingSnapshot(silentProfile, "quiet.json", { kind: "defaults" });
  await writeShipping(next, { root, snapshot: true });
  expect(
    (await readdir(join(root, "android/app/src/release/res/drawable"))).filter((file) =>
      file.endsWith(".xml"),
    ),
  ).toEqual([]);
  expect(
    (await readdir(join(root, "android/app/src/release/assets/switch-sounds"))).filter((file) =>
      file.endsWith(".wav"),
    ),
  ).toEqual([]);
  await writeShipping(next, { root, check: true });
});

test("missing, invalid and overlapping promotion inputs fail before writing user sources", async () => {
  const { root, input, selection } = await fixture();
  await expect(
    shippingCli([
      "promote",
      "--profile",
      join(root, "missing"),
      "--default-session",
      "--root",
      root,
    ]),
  ).rejects.toThrow();
  await expect(
    shippingCli([
      "promote",
      "--profile",
      input,
      "--session",
      selection,
      "--default-session",
      "--root",
      root,
    ]),
  ).rejects.toThrow("one explicit");
  await writeFile(
    selection,
    JSON.stringify({ ...session, icons: { channels: "arbitrary/path", push: "current" } }),
  );
  await expect(
    shippingCli(["promote", "--profile", input, "--session", selection, "--root", root]),
  ).rejects.toThrow();
  const overlap = join(root, "android/design/shipping-profile.json");
  await mkdir(dirname(overlap), { recursive: true });
  await writeFile(overlap, profileText);
  await expect(
    shippingCli(["promote", "--profile", overlap, "--default-session", "--root", root]),
  ).rejects.toThrow("overlaps");
  expect(await readFile(overlap, "utf8")).toBe(profileText);
  expect(await readFile(input, "utf8")).toBe(profileText);
});

test("explicit promotion advances the Studio baseline while regeneration preserves its identity and complete profile", async () => {
  const { root, input, selection } = await fixture();
  const args = ["promote", "--profile", input, "--session", selection, "--root", root];
  await shippingCli(args);
  const receipt = join(root, "android/design/shipping-provenance.json");
  const studio = join(
    root,
    "android/app/src/debug/java/com/arthack/agentvoice/StudioProduction.kt",
  );
  const first = parseShippingSnapshot(await readFile(receipt, "utf8"));
  expect(first.productionId).toBeString();
  const generated = await readFile(studio, "utf8");
  expect(generated).toContain(first.productionId!);
  expect(generated).toContain("appearanceOverrides");
  expect(generated).toContain("sharedAppearance");
  expect(generated).toContain("launcher");
  await shippingCli(["generate", "--root", root]);
  expect(await readFile(studio, "utf8")).toBe(generated);
  await shippingCli(args);
  const second = parseShippingSnapshot(await readFile(receipt, "utf8"));
  expect(second.productionId).not.toBe(first.productionId);
  expect(second.portrait).toEqual(first.portrait);
  expect(await readFile(input, "utf8")).toBe(profileText);
});

test("code-only release advances the Studio generation from validated production without importing a private draft", async () => {
  const { root, input, selection } = await fixture();
  await shippingCli(["promote", "--profile", input, "--session", selection, "--root", root]);
  const canonical = join(root, "android/design/shipping-profile.json");
  const receipt = join(root, "android/design/shipping-provenance.json");
  const before = await readFile(canonical, "utf8");
  const initial = parseShippingSnapshot(await readFile(receipt, "utf8"));
  await writeFile(input, "unreadable private draft must never be imported");
  await shippingCli(["release", "--root", root]);
  const released = parseShippingSnapshot(await readFile(receipt, "utf8"));
  expect(released.productionId).not.toBe(initial.productionId);
  expect(await readFile(canonical, "utf8")).toBe(before);
  expect(released.source).toEqual(initial.source);
  await shippingCli(["generate", "--check", "--root", root]);
  expect(() => shippingCli(["release", "--profile", input, "--root", root])).toThrow();
});
