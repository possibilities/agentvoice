#!/usr/bin/env bun
/**
 * One-time environment setup: verifies bun and codex, and installs sox
 * (required for the default client's speaker playback) via Homebrew when missing.
 */
export {};

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
  warn("codex not found on PATH — the server needs it: https://github.com/openai/codex");
}

// sox
if (Bun.which("play") ?? Bun.which("sox")) {
  ok("sox installed (default speaker playback)");
} else {
  const brew = Bun.which("brew");
  if (!brew) {
    fail("sox is missing and Homebrew is not available to install it.");
    fail("Install sox manually (https://sox.sourceforge.net), then re-run setup.");
    process.exit(1);
  }
  console.log("\n  installing sox via Homebrew…\n");
  const install = Bun.spawn([brew, "install", "sox"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await install.exited) !== 0) {
    fail("brew install sox failed — install it manually, then re-run setup.");
    process.exit(1);
  }
  ok("sox installed");
}

console.log("\nready:  bun run server   then, in another terminal:  bun run client");
