import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("prerequisites use PATH applied after a launchd-like process start", () => {
  const commands = mkdtempSync(join(tmpdir(), "agentvoice-prerequisites-"));
  roots.push(commands);
  for (const name of ["codex", "clang"]) {
    const path = join(commands, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o700);
  }
  const module = join(import.meta.dir, "../scripts/prerequisites.ts");
  const script = `
    process.env.PATH = ${JSON.stringify(commands)};
    const { checkPrerequisites } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify(checkPrerequisites()));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({
    codex: join(commands, "codex"),
    compiler: join(commands, "clang"),
  });
});

test("prerequisites do not fall back to the helper process start PATH", () => {
  const commands = mkdtempSync(join(tmpdir(), "agentvoice-prerequisites-start-"));
  roots.push(commands);
  for (const name of ["codex", "clang"]) {
    const path = join(commands, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o700);
  }
  const module = join(import.meta.dir, "../scripts/prerequisites.ts");
  const script = `
    process.env.PATH = "";
    const { checkPrerequisites } = await import(${JSON.stringify(module)});
    checkPrerequisites();
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { PATH: commands },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("stock Codex is required on PATH");
});
