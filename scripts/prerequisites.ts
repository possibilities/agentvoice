import { accessSync, constants, statSync } from "node:fs";

/** Presence checks only: never invoke Codex, authenticate, or open an audio device. */
export function checkPrerequisites(): { codex: string; compiler: string } {
  const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 3)) throw new Error("Bun 1.3+ is required");
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("the source installer supports macOS and Linux only");
  }
  const codex = Bun.which(process.env["CODEX_PATH"] ?? "codex");
  if (!codex || !statSync(codex).isFile()) {
    throw new Error("stock Codex is required on PATH (or set CODEX_PATH to its executable)");
  }
  accessSync(codex, constants.X_OK);
  const compiler = Bun.which("zig") ?? Bun.which("clang") ?? Bun.which("cc");
  if (!compiler) throw new Error("a C11 compiler is required (Zig, clang or cc)");
  return { codex, compiler };
}
