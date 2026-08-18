#!/usr/bin/env bun
/**
 * One-time environment setup: verifies bun and codex, and builds the native
 * duplex audio library the console cannot start without.
 */
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const bunExe = process.execPath;

const ok = (line: string) => console.log(`  ✓ ${line}`);
const warn = (line: string) => console.log(`  ! ${line}`);
const fail = (line: string) => console.error(`  ✗ ${line}`);

console.log("agentvoice setup\n");

// bun
const [major, minor] = Bun.version.split(".").map((n) => Number.parseInt(n, 10));
if ((major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 3)) {
  ok(`bun ${Bun.version}`);
} else {
  warn(`bun ${Bun.version} — 1.3+ recommended (OpenTUI)`);
}

// codex
const codex = process.env["CODEX_PATH"] ?? Bun.which("codex");
if (codex) {
  ok(`codex at ${codex}`);
} else {
  warn("codex not found on PATH — the resident needs it: https://github.com/openai/codex");
}

// native duplex audio — the console's only audio path, built from source
const compiler = Bun.which("zig") ?? Bun.which("clang") ?? Bun.which("cc");
if (!compiler) {
  fail("no C compiler found — the console's duplex audio device is built from source.");
  fail("Install Zig (https://ziglang.org) or a C11 compiler, then re-run setup.");
  process.exit(1);
}
ok(`C compiler at ${compiler}`);

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

console.log(
  "\nready:  agentvoice resident install   (once)   then:  bun run console   (or `agentvoice console`)",
);
