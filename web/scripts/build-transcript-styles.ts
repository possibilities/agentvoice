import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import postcss from "postcss";
import { build } from "vite";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") throw new Error("Use --check or --write");

const webRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(webRoot, "src", "transcript-ui");
const output = path.join(sourceRoot, "styles.css");
const buildDirectory = await mkdtemp(path.join(tmpdir(), "agentvoice-transcript-styles-"));

try {
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": sourceRoot } },
    build: {
      outDir: buildDirectory,
      emptyOutDir: true,
      lib: {
        entry: { styles: path.join(sourceRoot, "transcript", "styles.ts") },
        formats: ["es"],
        fileName: (_format, entry) => `${entry}.js`,
        cssFileName: "styles",
      },
    },
  });

  const cssPath = path.join(buildDirectory, "styles.css");
  const css = postcss.parse(await readFile(cssPath, "utf8"));
  css.walkRules((rule) => {
    rule.selector = rule.selector.replace(/:root|:host\b/g, ":scope");
  });
  const scoped = postcss.atRule({ name: "scope", params: "(.agentchats-transcript)" });
  const globalRules: postcss.AtRule[] = [];
  css.walkAtRules((rule) => {
    if (rule.name === "property" || rule.name === "keyframes") {
      globalRules.push(rule.clone());
      rule.remove();
    }
  });
  scoped.append(...css.nodes.map((node) => node.clone()));
  const generated = postcss.root({ nodes: [...globalRules, scoped] }).toString();
  if (mode === "--write") await writeFile(output, generated);
  else if ((await readFile(output, "utf8")) !== generated)
    throw new Error("Transcript styles are stale; run npm run transcript:styles");
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}
