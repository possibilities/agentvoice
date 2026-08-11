#!/usr/bin/env bun
/**
 * Editable install: dependencies, environment setup, native client audio, and a
 * global `agentvoice` command linked back to this checkout via `bun link`
 * — TypeScript edits apply immediately; native audio edits need `native:build`.
 * AgentStart invokes this same contract (`bun run cli:install`) from
 * ~/code/agentvoice.
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
    console.error(`agentvoice install: ${label} failed (exit ${code})`);
    process.exit(code || 1);
  }
}

await run("installing dependencies", [bun, "install"]);
await run("checking the environment and building native duplex audio", [
  bun,
  "run",
  join(root, "scripts", "setup.ts"),
]);
await run("linking a global agentvoice (editable)", [bun, "link"]);

const linked = Bun.which("agentvoice");
if (linked) {
  console.log(`\nagentvoice is on PATH at ${linked}, tracking ${root}`);
} else {
  console.log(
    `\nlinked, but agentvoice is not on PATH in this shell — ensure bun's global bin directory (usually ~/.bun/bin) is in PATH`,
  );
}
