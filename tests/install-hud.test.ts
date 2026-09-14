import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHud } from "../scripts/install-hud.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthud-install-")));
  temporary.push(base);
  const root = join(base, "checkout with spaces");
  const binDir = join(base, "bin");
  const stateDir = join(base, "state");
  mkdirSync(join(root, "src/hud"), { recursive: true });
  for (const path of ["src/main.ts", "src/hud/main.ts"])
    writeFileSync(join(root, path), "#!/usr/bin/env bun\n", { mode: 0o755 });
  const command = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  command("init", "-q");
  command("config", "user.name", "Fixture");
  command("config", "user.email", "fixture@example.invalid");
  command("config", "core.hooksPath", "/dev/null");
  command("remote", "add", "origin", "git@github.com:possibilities/agentvoice.git");
  command("add", ".");
  command("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return {
    root,
    binDir,
    stateDir,
    sha: command("rev-parse", "HEAD"),
    target: join(binDir, "agenthud"),
    source: join(root, "src/hud/main.ts"),
    receipt: join(stateDir, "deployed-sha"),
  };
}

test("HUD install publishes only its command and receipt and converges", async () => {
  const f = fixture();
  let preparations = 0;
  const prepare = async (root: string) => {
    expect(root).toBe(f.root);
    preparations++;
  };
  for (let i = 0; i < 2; i++) {
    expect((await installHud({ ...f, prepare })).sha).toBe(f.sha);
    expect(readlinkSync(f.target)).toBe(f.source);
    expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
    expect(existsSync(join(f.stateDir, ".install-lock"))).toBe(false);
  }
  expect(preparations).toBe(2);
  expect(existsSync(join(f.binDir, "agentvoice"))).toBe(false);
});

test("preparation failure preserves prior command and receipt", async () => {
  const f = fixture();
  await installHud({ ...f, prepare: async () => {} });
  await expect(
    installHud({
      ...f,
      prepare: async () => {
        throw new Error("build failed");
      },
    }),
  ).rejects.toThrow("build failed");
  expect(readlinkSync(f.target)).toBe(f.source);
  expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
  expect(existsSync(join(f.stateDir, ".install-lock"))).toBe(false);
});

test("dirty source and unrelated target refuse before preparation", async () => {
  for (const kind of ["dirty", "target", "writable"] as const) {
    const f = fixture();
    if (kind === "dirty") writeFileSync(f.source, "changed");
    if (kind === "writable") chmodSync(f.root, 0o777);
    if (kind === "target") {
      mkdirSync(f.binDir);
      writeFileSync(f.target, "human command");
    }
    let called = false;
    await expect(
      installHud({
        ...f,
        prepare: async () => {
          called = true;
        },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect(existsSync(f.receipt)).toBe(false);
    if (kind === "target") expect(readFileSync(f.target, "utf8")).toBe("human command");
  }
});

test("rechecks source and target after preparation", async () => {
  for (const kind of ["source", "target"] as const) {
    const f = fixture();
    await expect(
      installHud({
        ...f,
        prepare: async () => {
          if (kind === "source") writeFileSync(f.source, "changed");
          else writeFileSync(f.target, "human command");
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(f.receipt)).toBe(false);
    if (kind === "target") expect(readFileSync(f.target, "utf8")).toBe("human command");
  }
});

test("only matching install receipt permits moving a command between checkouts", async () => {
  const f = fixture();
  const previous = fixture();
  mkdirSync(f.binDir);
  mkdirSync(f.stateDir);
  symlinkSync(previous.source, f.target);
  await expect(installHud({ ...f, prepare: async () => {} })).rejects.toThrow("matching receipt");
  writeFileSync(f.receipt, `${previous.sha}\n`, { mode: 0o600 });
  await installHud({ ...f, prepare: async () => {} });
  expect(readlinkSync(f.target)).toBe(f.source);
});
