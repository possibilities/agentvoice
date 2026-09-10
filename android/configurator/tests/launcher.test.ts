import { expect, test } from "bun:test";
import { launcherConcepts, launcherStyles } from "../src/icons.ts";
import { launcherOutputPaths, launcherOutputs, launcherPaths } from "../src/launcher.ts";

test("every selected launcher generates only its adaptive, legacy and monochrome resources from original paths", async () => {
  for (const launcher of launcherStyles) {
    const concept = launcherConcepts.find((item) => item.id === launcher)!;
    const source = await Bun.file(
      new URL(`../public/icon-previews/${concept.color}`, import.meta.url),
    ).text();
    const mono = await Bun.file(
      new URL(`../public/icon-previews/${concept.monochrome}`, import.meta.url),
    ).text();
    const outputs = await launcherOutputs(launcher);
    expect([...outputs.keys()]).toEqual([...launcherOutputPaths]);
    const foreground = outputs.get(launcherOutputPaths[0])!;
    const monochrome = outputs.get(launcherOutputPaths[1])!;
    for (const path of [...source.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)]
      .map((match) => match[1]!)
      .filter((path) => path !== "M0,0h108v108h-108z"))
      expect(foreground).toContain(`android:pathData="${path}"`);
    for (const path of [...mono.matchAll(/\bd="([^"]*)"/g)].map((match) => match[1]!))
      expect(monochrome).toContain(`android:pathData="${path}"`);
    expect(foreground).not.toContain('android:fillColor="#050607"');
    expect(monochrome).not.toMatch(/#(?:D4FF72|BBAAFF|050607)/i);
    expect(outputs.get(launcherOutputPaths[2])).toContain('android:scaleX="1.5"');
    expect(outputs.get(launcherOutputPaths[2])).toContain('android:translateX="-27"');
    expect(outputs.get(launcherOutputPaths[3])).not.toContain("monochrome");
    expect(outputs.get(launcherOutputPaths[4])).toContain(
      '<monochrome android:drawable="@drawable/shipping_launcher_monochrome"',
    );
    expect(outputs.get(launcherOutputPaths[5])).toContain("#050607");
    for (const other of launcherStyles.filter((value) => value !== launcher))
      expect([...outputs.keys()].some((path) => path.includes(other))).toBe(false);
  }
});

test("launcher conversion rejects unsupported structure or geometry rather than silently changing artwork", () => {
  const original =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><path d="M0 0L10 10" fill="none" stroke="#000000" stroke-width="2"/></svg>';
  expect(launcherPaths(original)).toContain('android:strokeWidth="2"');
  for (const changed of [
    original.replace("108 108", "72 72"),
    original.replace("<path", "<g><path").replace("</svg>", "</g></svg>"),
    original.replace('fill="none"', 'fill="url(#remote)"'),
    original.replace("<path", '<path transform="scale(2)"'),
    original.replace("<svg ", '<svg opacity=".5" '),
    original.replace('stroke-width="2"', 'stroke-width="bad"'),
  ])
    expect(() => launcherPaths(changed)).toThrow();
});
