#!/usr/bin/env bun
/**
 * Editable install: dependencies, environment setup, native client audio, and a
 * global `agentvoicenext` command linked back to this checkout via `bun link`
 * — TypeScript edits apply immediately; native audio edits need `native:build`.
 * Funk invokes this same contract (`bun run cli:install`) from
 * ~/code/agentvoicenext.
 */
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const bun = process.execPath;

async function run(label: string, argv: string[]): Promise<void> {
  console.log(`\n— ${label}`);
  const child = Bun.spawn(argv, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    console.error(`agentvoicenext install: ${label} failed (exit ${code})`);
    process.exit(code || 1);
  }
}

await run("installing dependencies", [bun, "install"]);
await run("checking the environment (codex, sox)", [bun, "run", join(root, "scripts", "setup.ts")]);
await run("building native duplex audio", [bun, "run", join(root, "scripts", "build-native.ts")]);
await run("linking a global agentvoicenext (editable)", [bun, "link"]);

const linked = Bun.which("agentvoicenext");
if (linked) {
  console.log(`\nagentvoicenext is on PATH at ${linked}, tracking ${root}`);
} else {
  console.log(
    `\nlinked, but agentvoicenext is not on PATH in this shell — ensure bun's global bin directory (usually ~/.bun/bin) is in PATH`,
  );
}
