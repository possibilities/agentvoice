#!/usr/bin/env bun
/** Build the client-owned miniaudio duplex library for the current host. */

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const target = `${process.platform}-${process.arch}`;
const extension =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const output = join(root, "build", "native", target, `libagentvoice_audio.${extension}`);
const source = join(root, "src", "client", "native", "duplex_audio.c");

const zig = Bun.which("zig");
const compiler = zig ?? Bun.which("clang") ?? Bun.which("cc");
if (!compiler) {
  console.error("agentvoice native build: no C compiler found (install Zig or a C11 compiler)");
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });

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
  output,
  ...(process.platform === "linux" ? ["-pthread", "-ldl", "-lm"] : []),
];

console.log(`building ${target} duplex audio with ${compiler}${zig ? " cc" : ""}`);
const child = Bun.spawn(argv, {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const code = await child.exited;
if (code !== 0) process.exit(code || 1);

console.log(`built ${output} (${statSync(output).size.toLocaleString()} bytes)`);
