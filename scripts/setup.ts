#!/usr/bin/env bun
/**
 * One-time environment setup: verifies bun and codex, and builds the native
 * duplex audio library the console cannot start without.
 */
import { dirname, join } from "node:path";
import { checkPrerequisites } from "./prerequisites.ts";

const root = dirname(import.meta.dir);
const bunExe = process.execPath;

const ok = (line: string) => console.log(`  ✓ ${line}`);
const fail = (line: string) => console.error(`  ✗ ${line}`);

console.log("agentvoice setup\n");

try {
  const { codex, compiler } = checkPrerequisites();
  ok(`bun ${Bun.version}`);
  ok(`codex at ${codex} (not invoked)`);
  ok(`C compiler at ${compiler}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log("\n  building the duplex audio device…\n");
const build = Bun.spawn([bunExe, "run", join(root, "scripts", "build-native.ts")], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) {
  fail('duplex audio build failed — fix the toolchain, then run "bun run native:build".');
  process.exit(1);
}
ok("duplex audio device built");

console.log("\nready:  bun run console   (or `agentvoice`)");
