import { type LauncherStyle, launcherConcepts } from "./icons.ts";

const androidXml = 'xmlns:android="http://schemas.android.com/apk/res/android"';
const background = "#050607";
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function attributes(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const remaining = text.replace(/([\w:-]+)="([^"]*)"/g, (_, key: string, value: string) => {
    if (Object.hasOwn(values, key)) throw Error("Duplicate launcher SVG attribute");
    values[key] = value;
    return "";
  });
  if (remaining.trim()) throw Error("Unsupported launcher SVG attributes");
  return values;
}
export function launcherPaths(svg: string): string {
  const root = svg.match(/^<svg\b([^>]*)>/);
  if (!root || attributes(root[1]!)["viewBox"] !== "0 0 108 108")
    throw Error("Launcher SVG must use a108-unit source frame");
  const rootAttributes = attributes(root[1]!);
  if (
    Object.keys(rootAttributes).some(
      (name) =>
        !["xmlns", "width", "height", "viewBox", "role", "aria-label", "aria-labelledby"].includes(
          name,
        ),
    )
  )
    throw Error("Unsupported launcher SVG root attributes");
  const body = svg
    .slice(root[0].length)
    .replace(/<\/(?:svg)>\s*$/, "")
    .replace(
      /<!--[\s\S]*?-->|<title(?:\s[^>]*)?>[\s\S]*?<\/title>|<desc(?:\s[^>]*)?>[\s\S]*?<\/desc>/g,
      "",
    );
  const output: string[] = [];
  const remainder = body.replace(
    /<(path|rect)\b([^>]*?)\s*\/>/g,
    (_, element: string, raw: string) => {
      const data = attributes(raw);
      if (element === "rect") {
        if (
          data["width"] !== "108" ||
          data["height"] !== "108" ||
          data["fill"]?.toLowerCase() !== background ||
          Object.keys(data).length !== 3
        )
          throw Error("Only the fixed launcher background rectangle is supported");
        return "";
      }
      if (
        data["d"] === "M0,0h108v108h-108z" &&
        data["fill"]?.toLowerCase() === background &&
        Object.keys(data).length === 2
      )
        return "";
      const path = data["d"];
      if (!path || !/^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\s-]+$/.test(path))
        throw Error("Unsupported launcher SVG path");
      const mapped = [`android:pathData="${xml(path)}"`];
      const names: Record<string, string> = {
        fill: "fillColor",
        stroke: "strokeColor",
        "stroke-width": "strokeWidth",
        "stroke-linecap": "strokeLineCap",
        "stroke-linejoin": "strokeLineJoin",
      };
      for (const [name, value] of Object.entries(data)) {
        if (name === "d") continue;
        const target = names[name];
        if (!target) throw Error(`Unsupported launcher SVG attribute: ${name}`);
        if (
          (name === "fill" || name === "stroke") &&
          value !== "none" &&
          !/^#[a-f\d]{6}$/i.test(value)
        )
          throw Error("Launcher paint must be an explicit RGB color");
        if (name === "stroke-width" && !/^\d+(?:\.\d+)?$/.test(value))
          throw Error("Invalid launcher stroke width");
        if (name === "stroke-linecap" && !["butt", "round", "square"].includes(value))
          throw Error("Invalid launcher line cap");
        if (name === "stroke-linejoin" && !["miter", "round", "bevel"].includes(value))
          throw Error("Invalid launcher line join");
        mapped.push(
          `android:${target}="${value === "none" ? "@android:color/transparent" : xml(value)}"`,
        );
      }
      if (!Object.hasOwn(data, "fill")) mapped.push('android:fillColor="#000000"');
      output.push(`    <path ${mapped.join(" ")} />`);
      return "";
    },
  );
  if (remainder.trim() || !output.length) throw Error("Unsupported launcher SVG structure");
  return output.join("\n");
}
function vector(paths: string): string {
  return `<vector ${androidXml} android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n${paths}\n</vector>\n`;
}
export const launcherOutputPaths = [
  "android/app/src/main/res/drawable/shipping_launcher_foreground.xml",
  "android/app/src/main/res/drawable/shipping_launcher_monochrome.xml",
  "android/app/src/main/res/mipmap-anydpi/ic_agentvoice.xml",
  "android/app/src/main/res/mipmap-anydpi-v26/ic_agentvoice.xml",
  "android/app/src/main/res/mipmap-anydpi-v33/ic_agentvoice.xml",
  "android/app/src/main/res/values/shipping_launcher.xml",
] as const;
export async function launcherOutputs(launcher: LauncherStyle): Promise<Map<string, string>> {
  const concept = launcherConcepts.find((candidate) => candidate.id === launcher);
  if (!concept) throw Error("Unknown shipping launcher");
  const color = launcherPaths(
    await Bun.file(new URL(`../public/icon-previews/${concept.color}`, import.meta.url)).text(),
  );
  const mono = launcherPaths(
    await Bun.file(
      new URL(`../public/icon-previews/${concept.monochrome}`, import.meta.url),
    ).text(),
  );
  const adaptive = (themed: boolean) =>
    `<adaptive-icon ${androidXml}>\n    <background android:drawable="@color/shipping_launcher_background" />\n    <foreground android:drawable="@drawable/shipping_launcher_foreground" />\n${themed ? '    <monochrome android:drawable="@drawable/shipping_launcher_monochrome" />\n' : ""}</adaptive-icon>\n`;
  // Android's adaptive mask exposes the central72 units of the108-unit source.
  const legacy = vector(
    `    <path android:fillColor="${background}" android:pathData="M0,0h108v108h-108z" />\n    <group android:scaleX="1.5" android:scaleY="1.5" android:translateX="-27" android:translateY="-27">\n${color}\n    </group>`,
  );
  return new Map([
    [launcherOutputPaths[0], vector(color)],
    [launcherOutputPaths[1], vector(mono)],
    [launcherOutputPaths[2], legacy],
    [launcherOutputPaths[3], adaptive(false)],
    [launcherOutputPaths[4], adaptive(true)],
    [
      launcherOutputPaths[5],
      `<resources>\n    <color name="shipping_launcher_background">${background}</color>\n</resources>\n`,
    ],
  ]);
}
