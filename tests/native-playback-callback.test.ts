import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function commandOutput(command: string[], label: string): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
  if (result.exitCode !== 0) throw new Error(`${label} failed:\n${output}`);
  return output;
}

test("native playback callback keeps startup priming and uses the recovery floor after underrun", () => {
  const compiler = Bun.which("zig") ?? Bun.which("clang") ?? Bun.which("cc");
  if (!compiler) throw new Error("native playback regression requires Zig, clang, or a C compiler");

  const directory = mkdtempSync(join(tmpdir(), "agentvoice-native-playback-"));
  const executable = join(directory, "native-playback-callback");
  const source = join(import.meta.dir, "native-playback-callback.test.c");
  const command = [
    compiler,
    ...(compiler.endsWith("zig") ? ["cc"] : []),
    "-std=c11",
    "-O1",
    "-UNDEBUG",
    "-Wall",
    "-Wextra",
    "-Werror",
    source,
    "-o",
    executable,
    ...(process.platform === "linux" ? ["-pthread", "-ldl", "-lm"] : []),
  ];

  try {
    commandOutput(command, "native playback regression build");
    expect(existsSync(executable)).toBe(true);
    expect(commandOutput([executable], "native playback regression")).toContain(
      "native playback callback regression: PASS",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
