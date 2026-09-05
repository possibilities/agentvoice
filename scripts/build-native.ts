#!/usr/bin/env bun
/** Build the client-owned miniaudio duplex library for the current host. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const target = `${process.platform}-${process.arch}`;
const extension =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const output = join(root, "build", "native", target, `libagentvoice_audio.${extension}`);
const source = join(root, "src", "console", "native", "duplex_audio.c");

const zig = Bun.which("zig");
const compiler = zig ?? Bun.which("clang") ?? Bun.which("cc");
if (!compiler) {
  console.error("agentvoice native build: no C compiler found (install Zig or a C11 compiler)");
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });
// A failed compile must not truncate the library used by an existing editable install.
const staging = mkdtempSync(join(dirname(output), ".audio-build-"));
const candidate = join(staging, `libagentvoice_audio.${extension}`);

const argv = [
  compiler,
  ...(zig ? ["cc"] : []),
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"]),
  ...(process.platform === "win32" ? [] : ["-fvisibility=hidden"]),
  source,
  "-o",
  candidate,
  ...(process.platform === "linux" ? ["-pthread", "-ldl", "-lm"] : []),
];

console.log(`building ${target} duplex audio with ${compiler}${zig ? " cc" : ""}`);
try {
  const child = Bun.spawn(argv, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`compiler failed (exit ${code})`);
  if (statSync(candidate).size === 0) throw new Error("compiler produced an empty library");
  renameSync(candidate, output);
  console.log(`built ${output} (${statSync(output).size.toLocaleString()} bytes)`);
} finally {
  if (existsSync(candidate)) unlinkSync(candidate);
  rmdirSync(staging);
}
