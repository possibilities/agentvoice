import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { iconCatalog } from "./icons.ts";
import { launcherOutputPaths, launcherOutputs } from "./launcher.ts";
import {
  defaultVisualSettings,
  equalLayout,
  equalVisualSettings,
  exact,
  integer,
  type Layout,
  layoutOf,
  type Profile,
  parseLayout,
  parseProfile,
  parseState,
  parseVisualSettings,
  profileLayout,
  profileSounds,
  profileVisualSettings,
  record,
  stateLayouts,
  type VisualSettings,
  visualSettingsOf,
} from "./protocol.ts";
import { equalSounds, parseSounds, type Sounds } from "./sounds.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const snapshotPath = "android/design/shipping-profile.json";
const provenancePath = "android/design/shipping-provenance.json";
const kotlinPath = "android/app/src/main/java/com/arthack/agentvoice/ShippingDesign.kt";
const studioPath = "android/app/src/debug/java/com/arthack/agentvoice/StudioProduction.kt";
const manifestPath = "android/design/shipping-generated-files.json";
const releaseRoot = "android/app/src/release/";
const noticesRoot = "android/app/src/main/assets/notices/Shipping-";
export type ShippingSnapshot = {
  version: 2;
  source: {
    profile: { path: string; sha256: string; text: string };
    session: {
      kind: "profile" | "file" | "live" | "defaults";
      path: string | null;
      sha256: string | null;
      valuesSha256: string;
    };
  };
  portrait: Layout;
  landscape: Layout;
  portraitReverse: Layout;
  landscapeReverse: Layout;
  sounds: Sounds;
  appearance: VisualSettings;
};
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canonicalJson(value: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b, "en"))
          .map(([key, item]) => [key, sorted(item)]),
      );
    return value;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
function sourceName(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 2048 || value.includes("\0"))
    throw Error("Invalid source provenance path");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid provenance hash");
  return value;
}
export function createShippingSnapshot(
  profileText: string,
  profilePath: string,
  choice:
    | { kind: "file" | "live"; text: string; path: string }
    | { kind: "defaults" }
    | { kind: "profile" },
): ShippingSnapshot {
  const profile = parseProfile(profileText);
  if (
    profile.version !== 18 &&
    profile.version !== 19 &&
    profile.version !== 20 &&
    profile.version !== 21
  )
    throw Error("Promotion requires profile18 through profile21");
  const portrait = profileLayout(profile, "portrait");
  const landscape = profileLayout(profile, "landscape");
  const portraitReverse = profileLayout(profile, "portrait-reverse");
  const landscapeReverse = profileLayout(profile, "landscape-reverse");
  const sounds = profileSounds(profile);
  let appearance: VisualSettings;
  if (choice.kind === "defaults") appearance = defaultVisualSettings();
  else if (choice.kind === "profile") {
    if (profile.version !== 19 && profile.version !== 20 && profile.version !== 21)
      throw Error("Profile18 needs --session, --live-state or --default-session");
    appearance = profileVisualSettings(profile);
  } else if (choice.kind === "file") appearance = parseVisualSettings(JSON.parse(choice.text));
  else {
    const wrapper = record(JSON.parse(choice.text));
    const state = record(wrapper["state"] ?? wrapper);
    if (![21, 22, 23, 24, 25, 26, 27, 28].includes(state["protocol"] as number))
      throw Error("Unsupported captured studio protocol");
    integer(state["revision"]);
    if (
      state["orientation"] !== "portrait" &&
      state["orientation"] !== "landscape" &&
      state["orientation"] !== "portrait-reverse" &&
      state["orientation"] !== "landscape-reverse"
    )
      throw Error("Invalid captured orientation");
    const capturedLayouts =
      state["protocol"] === 27 || state["protocol"] === 28
        ? stateLayouts(parseState({ ...state, protocol: 28 }))
        : null;
    const layouts = capturedLayouts ?? {
      portrait:
        state["orientation"] === "portrait"
          ? parseLayout(layoutOf(state as unknown as Layout))
          : parseLayout(state["otherLayout"]),
      landscape:
        state["orientation"] === "landscape"
          ? parseLayout(layoutOf(state as unknown as Layout))
          : parseLayout(state["otherLayout"]),
    };
    if (
      !equalLayout(portrait, layouts.portrait) ||
      !equalLayout(landscape, layouts.landscape) ||
      (capturedLayouts !== null &&
        (!equalLayout(portraitReverse, capturedLayouts["portrait-reverse"]) ||
          !equalLayout(landscapeReverse, capturedLayouts["landscape-reverse"]))) ||
      !equalSounds(sounds, parseSounds(state["sounds"]))
    )
      throw Error(
        "Captured live design or sounds differ from the saved profile; review before promotion",
      );
    appearance = visualSettingsOf(
      state["protocol"] === 23 ||
        state["protocol"] === 24 ||
        state["protocol"] === 27 ||
        state["protocol"] === 28
        ? state
        : { ...state, launcher: "current" },
    );
  }
  return {
    version: 2,
    source: {
      profile: { path: sourceName(profilePath), sha256: sha256(profileText), text: profileText },
      session: {
        kind: choice.kind,
        path: "path" in choice ? sourceName(choice.path) : null,
        sha256: "text" in choice ? sha256(choice.text) : null,
        valuesSha256: sha256(canonicalJson(appearance)),
      },
    },
    portrait,
    landscape,
    portraitReverse,
    landscapeReverse,
    sounds,
    appearance,
  };
}
export function parseShippingSnapshot(text: string): ShippingSnapshot {
  if (text.length > 65536) throw Error("Shipping snapshot too large");
  const value = record(JSON.parse(text));
  const version = value["version"];
  if (version !== 1 && version !== 2) throw Error("Unsupported shipping snapshot");
  exact(
    value,
    version === 1
      ? ["version", "source", "portrait", "landscape", "sounds", "appearance"]
      : [
          "version",
          "source",
          "portrait",
          "landscape",
          "portraitReverse",
          "landscapeReverse",
          "sounds",
          "appearance",
        ],
  );
  const source = record(value["source"]);
  exact(source, ["profile", "session"]);
  const profile = record(source["profile"]);
  exact(profile, ["path", "sha256", "text"]);
  sourceName(profile["path"]);
  digest(profile["sha256"]);
  if (typeof profile["text"] !== "string" || sha256(profile["text"]) !== profile["sha256"])
    throw Error("Source profile provenance mismatch");
  const session = record(source["session"]);
  exact(session, ["kind", "path", "sha256", "valuesSha256"]);
  if (!["profile", "file", "live", "defaults"].includes(session["kind"] as string))
    throw Error("Invalid session provenance");
  if (session["kind"] === "file" || session["kind"] === "live") {
    sourceName(session["path"]);
    digest(session["sha256"]);
  } else if (session["path"] !== null || session["sha256"] !== null)
    throw Error("Unexpected session source");
  const rawAppearance = record(value["appearance"]);
  const legacyAppearance =
    !Object.hasOwn(rawAppearance, "launcher") && parseProfile(profile["text"]).version < 20;
  const appearance = parseVisualSettings(
    legacyAppearance ? { ...rawAppearance, launcher: "current" } : rawAppearance,
  );
  if (
    digest(session["valuesSha256"]) !==
    sha256(canonicalJson(legacyAppearance ? rawAppearance : appearance))
  )
    throw Error("Session snapshot provenance mismatch");
  const original = createShippingSnapshot(profile["text"], profile["path"] as string, {
    kind: session["kind"] === "profile" ? "profile" : "defaults",
  });
  const portrait = parseLayout(value["portrait"]);
  const landscape = parseLayout(value["landscape"]);
  const sourceProfile = parseProfile(profile["text"]);
  const portraitReverse =
    version === 2
      ? parseLayout(value["portraitReverse"])
      : profileLayout(sourceProfile, "portrait-reverse");
  const landscapeReverse =
    version === 2
      ? parseLayout(value["landscapeReverse"])
      : profileLayout(sourceProfile, "landscape-reverse");
  const sounds = parseSounds(value["sounds"]);
  if (
    !equalLayout(portrait, original.portrait) ||
    !equalLayout(landscape, original.landscape) ||
    !equalLayout(portraitReverse, original.portraitReverse) ||
    !equalLayout(landscapeReverse, original.landscapeReverse) ||
    !equalSounds(sounds, original.sounds)
  )
    throw Error("Shipping snapshot differs from source profile");
  if (
    (session["kind"] === "profile" || session["kind"] === "defaults") &&
    !equalVisualSettings(appearance, original.appearance)
  )
    throw Error("Shipping appearance differs from declared source");
  return {
    version: 2,
    source: source as ShippingSnapshot["source"],
    portrait,
    landscape,
    portraitReverse,
    landscapeReverse,
    sounds,
    appearance,
  };
}
export function completeShippingProfile(
  snapshot: ShippingSnapshot,
): Extract<Profile, { version: 21 }> {
  const source = parseProfile(snapshot.source.profile.text);
  if (
    source.version !== 18 &&
    source.version !== 19 &&
    source.version !== 20 &&
    source.version !== 21
  )
    throw Error("Unsupported shipping profile source");
  return {
    ...source,
    version: 21,
    portraitReverse: snapshot.portraitReverse,
    landscapeReverse: snapshot.landscapeReverse,
    ...snapshot.appearance,
  } as Extract<Profile, { version: 21 }>;
}
function validateShippingProfile(profile: Profile, snapshot: ShippingSnapshot): void {
  if (
    (profile.version !== 20 && profile.version !== 21) ||
    !equalLayout(profileLayout(profile, "portrait"), snapshot.portrait) ||
    !equalLayout(profileLayout(profile, "landscape"), snapshot.landscape) ||
    !equalLayout(profileLayout(profile, "portrait-reverse"), snapshot.portraitReverse) ||
    !equalLayout(profileLayout(profile, "landscape-reverse"), snapshot.landscapeReverse) ||
    !equalSounds(profileSounds(profile), snapshot.sounds) ||
    !equalVisualSettings(profileVisualSettings(profile), snapshot.appearance)
  )
    throw Error("Canonical shipping profile differs from promotion receipt; promote explicitly");
}
export function kotlinString(value: string): string {
  const escaped = [...value]
    .map((char) => {
      if (char === "\\") return "\\\\";
      if (char === '"') return '\\"';
      if (char === "$") return "\\$";
      const code = char.charCodeAt(0);
      if (code < 32 || code === 0x2028 || code === 0x2029)
        return `\\u${code.toString(16).padStart(4, "0")}`;
      return char;
    })
    .join("");
  return `"${escaped}"`;
}

function number(value: number, float = false): string {
  const text = String(value);
  return `${text.includes(".") ? text : `${text}.0`}${float ? "f" : ""}`;
}
function kotlinConstructor(name: string, fields: Record<string, unknown>, indent = 8): string {
  return `${name}(\n${Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(
      ([key, value]) =>
        `${" ".repeat(indent)}${key} = ${typeof value === "string" ? kotlinString(value) : value},`,
    )
    .join("\n")}\n${" ".repeat(indent - 4)})`;
}
function layoutKotlin(layout: Layout): string {
  const { design, halo, spirit } = layout;
  return `ShippingLayout(\n        placement = PersonaPlacement(speakingScale = ${number(layout.scales.speaking / 100, true)}, listeningScale = ${number(layout.scales.listening / 100, true)}, idleScale = ${number(layout.scales.idle / 100, true)}, offsetY = ${layout.verticalOffsetDp}.dp),\n        design = PreviewDesign(\n            layout = ${kotlinString(design.layout)}, header = ${kotlinString(design.header)},\n            controlsHeightDp = ${design.controlsHeightDp}, controlsWithoutPttDp = ${design.controlsWithoutPttDp}, holdSharePercent = ${number(design.holdSharePercent)},\n            traces = ${kotlinConstructor("PreviewTraces", design.traces, 16)},\n            spacing = ${kotlinConstructor("PreviewSpacing", design.spacing, 16)},\n        ),\n        halo = ${kotlinConstructor("PreviewHalo", { variant: halo.variant, containedSizePercent: halo.containedSizePercent, ringSpreadPercent: halo.ringSpreadPercent, listeningPulsePercent: halo.listeningPulsePercent, speakingMotionPercent: halo.speakingMotionPercent, idleBreathingPercent: halo.idleBreathingPercent, speakingColor: halo.colors.speaking, listeningColor: halo.colors.listening, idleColor: halo.colors.idle }, 12)},\n        spirit = ${kotlinConstructor("PreviewSpirit", spirit, 12)},\n        personaSide = ${kotlinString(layout.personaSide)}, horizontalOffsetDp = ${layout.horizontalOffsetDp},\n    )`;
}
export function generateKotlin(snapshot: ShippingSnapshot): string {
  const { appearance } = snapshot;
  return [
    "// Generated by android/configurator/src/shipping.ts. Regenerate; do not edit.",
    "package com.arthack.agentvoice",
    "",
    "import androidx.compose.ui.unit.dp",
    "",
    "internal data class ShippingLayout(",
    "    val placement: PersonaPlacement,",
    "    val design: PreviewDesign,",
    "    val halo: PreviewHalo,",
    "    val spirit: PreviewSpirit,",
    "    val personaSide: String,",
    "    val horizontalOffsetDp: Int,",
    ")",
    "",
    "internal object ShippingDesign {",
    `    const val profileSource = ${kotlinString(snapshot.source.profile.path)}`,
    `    const val profileSha256 = ${kotlinString(snapshot.source.profile.sha256)}`,
    `    const val sessionSha256 = ${kotlinString(snapshot.source.session.valuesSha256)}`,
    `    val portrait = ${layoutKotlin(snapshot.portrait)}`,
    `    val landscape = ${layoutKotlin(snapshot.landscape)}`,
    `    val portraitReverse = ${layoutKotlin(snapshot.portraitReverse)}`,
    `    val landscapeReverse = ${layoutKotlin(snapshot.landscapeReverse)}`,
    `    val sounds = ${kotlinConstructor("PreviewSounds", snapshot.sounds)}`,
    `    val icons = ${kotlinConstructor("PreviewIcons", appearance.icons)}`,
    `    const val launcher = ${kotlinString(appearance.launcher)}`,
    `    const val theme = ${kotlinString(appearance.theme)}`,
    `    const val mutedPresence = ${kotlinString(appearance.mutedPresence)}`,
    `    const val presenceScope = ${kotlinString(appearance.presenceScope)}`,
    `    val mutedTuning = ${kotlinConstructor("PreviewMutedTuning", appearance.mutedTuning)}`,
    `    const val showPushToTalk = ${appearance.showPushToTalk}`,
    "}",
    "",
  ].join("\n");
}
function iconResources(family: string): string[] {
  if (family === "current") return [];
  if (family === "engraved")
    return ["mic", "mic_muted", "speaker", "speaker_muted"].map(
      (part) => `preview_engraved_${part}`,
    );
  if (family === "noun-boatman" || family === "noun-icons")
    return ["mic", "mic_muted", "speaker", "speaker_muted"].map(
      (part) => `preview_${family.replaceAll("-", "_")}_${part}`,
    );
  const weight = family === "phosphor-bold" ? "bold" : "fill";
  return ["microphone", "microphone_slash", "speaker_high", "speaker_slash"].map(
    (part) => `preview_phosphor_${part}_${weight}`,
  );
}
export async function shippingOutputs(
  snapshot: ShippingSnapshot,
): Promise<Map<string, string | Uint8Array>> {
  const result = new Map<string, string | Uint8Array>([[kotlinPath, generateKotlin(snapshot)]]);
  result.set(
    studioPath,
    `// Generated by shipping.ts; debug only.
package com.arthack.agentvoice

internal object StudioProduction {
    const val profile = ${kotlinString(canonicalJson(completeShippingProfile(snapshot)))}
}
`,
  );
  for (const [path, contents] of await launcherOutputs(snapshot.appearance.launcher))
    result.set(path, contents);
  const family = snapshot.appearance.icons.channels;
  const resources = iconResources(family);
  const releaseNames = ["mic", "mic_muted", "speaker", "speaker_muted"].map(
    (part) => `shipping_channel_${part}`,
  );
  for (const [index, name] of resources.entries())
    result.set(
      `${releaseRoot}res/drawable/${releaseNames[index]}.xml`,
      await readFile(resolve(repositoryRoot, `android/app/src/debug/res/drawable/${name}.xml`)),
    );
  result.set(
    `${releaseRoot}java/com/arthack/agentvoice/PreviewIcons.kt`,
    `// Generated shipping icon provider.\npackage com.arthack.agentvoice\n\nimport androidx.compose.runtime.Composable\nimport androidx.compose.ui.graphics.painter.Painter\n${resources.length ? "import androidx.compose.ui.res.painterResource\n" : ""}\n@Composable\ninternal fun previewChannelPainter(speaker: Boolean, muted: Boolean): Painter? {\n${resources.length ? `    if (LocalPreviewIcons.current.channels != ${kotlinString(family)}) return null\n    val resource = if (speaker) {\n        if (muted) R.drawable.shipping_channel_speaker_muted else R.drawable.shipping_channel_speaker\n    } else {\n        if (muted) R.drawable.shipping_channel_mic_muted else R.drawable.shipping_channel_mic\n    }\n    return painterResource(resource)` : "    return null"}\n}\n`,
  );
  const soundFamily = snapshot.sounds.family;
  result.set(
    `${releaseRoot}java/com/arthack/agentvoice/SwitchSoundFamilies.kt`,
    `// Generated shipping sound inventory.\npackage com.arthack.agentvoice\n\ninternal fun bundledSwitchFamilies(): List<String> = ${soundFamily === "off" ? "emptyList()" : `listOf(${kotlinString(soundFamily)})`}\n`,
  );
  if (soundFamily !== "off") {
    for (const part of ["toggle-on", "toggle-off", "ptt-down", "ptt-up"]) {
      const filename = `${soundFamily}-${part}.wav`;
      result.set(
        `${releaseRoot}assets/switch-sounds/${filename}`,
        await readFile(
          resolve(repositoryRoot, `android/app/src/debug/assets/switch-sounds/${filename}`),
        ),
      );
    }
    result.set(
      `${noticesRoot}Sounds-LICENSE.txt`,
      await readFile(
        resolve(repositoryRoot, "android/app/src/debug/assets/switch-sounds/LICENSE.txt"),
      ),
    );
    result.set(
      `${noticesRoot}Sounds-NOTICE.txt`,
      `AgentVoice shipping switch sounds: ${soundFamily}.\nInterface sounds adapted from Kenney Vleugels’ UI SFX Set (CC0).\nhttps://kenney.nl/assets/ui-audio\nhttps://github.com/Calinou/kenney-ui-audio/tree/8c3d81b9159d058c444f89d12d518276b0b09345\nSelected toggle on/off and push-to-talk down/up recordings; trimmed, downmixed, resampled and pitch/level adjusted.\nSee Shipping-Sounds-LICENSE.txt for the bundled license.\n`,
    );
  }
  const credit = iconCatalog[family].credit;
  let notice = `AgentVoice shipping channel icons: ${iconCatalog[family].label}\n${credit.author} (${credit.tag}).\n`;
  for (const source of [
    credit.source,
    ...(credit.sources ?? []).map((item) => item.url),
    credit.license,
  ])
    if (source) notice += `${source}\n`;
  if (credit.changes) notice += `${credit.changes}\n`;
  notice += `Push-to-talk icon: ${snapshot.appearance.icons.push}.\n`;
  if (family === "noun-icons")
    notice +=
      "These sources and derivatives remain CC BY 3.0. A distributor's separately purchased attribution waiver does not extend to downstream forks; downstream apps must provide attribution or obtain their own applicable license.\n";
  result.set(`${noticesRoot}Icons-NOTICE.txt`, notice);
  if (family.startsWith("noun-"))
    result.set(
      `${noticesRoot}Icons-LICENSE.txt`,
      await readFile(
        resolve(repositoryRoot, "android/third-party/icons/noun-project/CC-BY-3.0.txt"),
      ),
    );
  else if (family.startsWith("phosphor-"))
    result.set(
      `${noticesRoot}Icons-LICENSE.txt`,
      await readFile(resolve(repositoryRoot, "android/third-party/icons/phosphor/LICENSE.txt")),
    );
  return result;
}
function allowedGenerated(path: string): boolean {
  return (
    path === kotlinPath ||
    path === studioPath ||
    (launcherOutputPaths as readonly string[]).includes(path) ||
    ["mic", "mic_muted", "speaker", "speaker_muted"].some(
      (part) => path === `${releaseRoot}res/drawable/shipping_channel_${part}.xml`,
    ) ||
    path === `${releaseRoot}java/com/arthack/agentvoice/PreviewIcons.kt` ||
    path === `${releaseRoot}java/com/arthack/agentvoice/SwitchSoundFamilies.kt` ||
    /^android\/app\/src\/release\/assets\/switch-sounds\/rocker-(?:13|29)-(?:toggle-on|toggle-off|ptt-down|ptt-up)\.wav$/.test(
      path,
    ) ||
    ["Icons-NOTICE.txt", "Icons-LICENSE.txt", "Sounds-NOTICE.txt", "Sounds-LICENSE.txt"].some(
      (name) => path === `${noticesRoot}${name}`,
    )
  );
}
async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await physicalPath(parent), basename(path));
  }
}
async function atomicWrite(path: string, contents: string | Uint8Array) {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && !existing.isFile()) throw Error("Generated destination must be a regular file");
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function writeShipping(
  snapshot: ShippingSnapshot,
  options: { root?: string; check?: boolean; snapshot?: boolean; protectedPaths?: string[] } = {},
): Promise<void> {
  const root = resolve(options.root ?? repositoryRoot);
  const outputs = await shippingOutputs(snapshot);
  if (options.snapshot) {
    outputs.set(snapshotPath, canonicalJson(completeShippingProfile(snapshot)));
    outputs.set(provenancePath, canonicalJson(snapshot));
  }
  const generatedPaths = [...outputs.keys()]
    .filter((path) => path !== snapshotPath && path !== provenancePath)
    .sort();
  const manifest = resolve(root, manifestPath);
  let previous: string[] = [];
  try {
    const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (
      !Array.isArray(data) ||
      !data.every(
        (path) =>
          typeof path === "string" && allowedGenerated(path) && !path.split("/").includes(".."),
      )
    )
      throw Error("Invalid generated file inventory");
    previous = data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  outputs.set(manifestPath, canonicalJson(generatedPaths));
  const protectedPaths = await Promise.all(
    (options.protectedPaths ?? []).map((path) => physicalPath(resolve(path))),
  );
  for (const path of [...outputs.keys(), ...previous]) {
    const physical = await physicalPath(resolve(root, path));
    if (protectedPaths.includes(physical)) throw Error("Generated output overlaps a source input");
    if (!physical.startsWith(`${await physicalPath(root)}${sep}`))
      throw Error("Generated output escapes repository root");
  }
  const stale = previous.filter((path) => !generatedPaths.includes(path));
  if (options.check) {
    for (const [path, content] of outputs) {
      const existing = await readFile(resolve(root, path)).catch(() => null);
      if (!existing?.equals(Buffer.from(content)))
        throw Error(`Generated shipping file is missing or stale: ${path}`);
    }
    if (stale.length) throw Error(`Obsolete generated shipping files: ${stale.join(", ")}`);
    return;
  }
  for (const [path, content] of outputs)
    if (path !== manifestPath) await atomicWrite(resolve(root, path), content);
  for (const path of stale) await rm(resolve(root, path), { force: true });
  await atomicWrite(manifest, outputs.get(manifestPath)!);
}
export async function shippingCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "promote" && command !== "generate")
    throw Error(
      "Usage: shipping.ts promote --profile FILE [--session FILE | --live-state FILE | --default-session] [--root DIR]; shipping.ts generate [--check] [--root DIR]",
    );
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    const allowed =
      command === "promote"
        ? ["--profile", "--session", "--live-state", "--default-session", "--root"]
        : ["--check", "--root"];
    if (!allowed.includes(flag) || flags.has(flag))
      throw Error(`Unknown or duplicate option: ${flag}`);
    if (flag === "--check" || flag === "--default-session") flags.set(flag, true);
    else {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw Error(`Missing value for ${flag}`);
      flags.set(flag, value);
    }
  }
  const root = resolve((flags.get("--root") as string) ?? repositoryRoot);
  if (command === "generate") {
    const path = resolve(root, snapshotPath);
    const receiptPath = resolve(root, provenancePath);
    const snapshot = parseShippingSnapshot(await readFile(receiptPath, "utf8"));
    validateShippingProfile(parseProfile(await readFile(path, "utf8")), snapshot);
    await writeShipping(snapshot, {
      root,
      check: flags.has("--check"),
      protectedPaths: [path, receiptPath],
    });
    return;
  }
  const profilePath = flags.get("--profile");
  if (typeof profilePath !== "string") throw Error("Promotion requires --profile");
  const choices = ["--session", "--live-state", "--default-session"].filter((flag) =>
    flags.has(flag),
  );
  if (choices.length > 1) throw Error("Choose one explicit session source");
  const flag = choices[0];
  const source = flag ? flags.get(flag) : undefined;
  const name = (path: string) => {
    const fromRoot = relative(root, resolve(path));
    return isAbsolute(fromRoot) ? resolve(path) : fromRoot.split(sep).join("/");
  };
  const choice =
    typeof source === "string"
      ? {
          kind: flag === "--live-state" ? ("live" as const) : ("file" as const),
          path: name(source),
          text: await readFile(source, "utf8"),
        }
      : { kind: flag === "--default-session" ? ("defaults" as const) : ("profile" as const) };
  const snapshot = createShippingSnapshot(
    await readFile(profilePath, "utf8"),
    name(profilePath),
    choice,
  );
  await writeShipping(snapshot, {
    root,
    snapshot: true,
    protectedPaths: [profilePath, ...(typeof source === "string" ? [source] : [])],
  });
}
if (import.meta.main) {
  try {
    await shippingCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Shipping generation failed");
    process.exitCode = 1;
  }
}
