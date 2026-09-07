import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = dirname(import.meta.dir);
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-install-test-")));
  temporary.push(base);
  const root = join(base, "checkout with spaces");
  const bin = join(base, "bin");
  const state = join(base, "state");
  const commands = join(base, "commands");
  for (const dir of [
    root,
    bin,
    state,
    commands,
    join(root, "scripts"),
    join(root, "src"),
    join(root, "fixture-dep"),
  ]) {
    mkdirSync(dir);
  }
  for (const name of [
    "install.sh",
    "install.ts",
    "prerequisites.ts",
    "build-native.ts",
    "setup.ts",
  ]) {
    copyFileSync(join(repository, "scripts", name), join(root, "scripts", name));
  }
  for (const name of ["service.ts", "paths.ts", "private-files.ts"]) {
    copyFileSync(join(repository, "src", name), join(root, "src", name));
  }
  for (const name of ["bun", "git", "dirname", "bash"]) {
    symlinkSync(name === "bun" ? process.execPath : Bun.which(name)!, join(commands, name));
  }
  const env: Record<string, string> = {
    PATH: commands,
    AGENTVOICE_INSTALL_BIN_DIR: bin,
    AGENTVOICE_INSTALL_STATE_DIR: state,
    XDG_STATE_HOME: join(base, "xdg-state"),
    XDG_CACHE_HOME: join(base, "cache"),
    BUN_INSTALL_CACHE_DIR: join(base, "bun-cache"),
    BUN_CONFIG_NO_CLEAR_TERMINAL: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    FIXTURE_ROOT: root,
    FIXTURE_BASE: base,
    FIXTURE_COMPILER_EXIT: "0",
  };
  const source = join(root, "src/main.ts");
  writeFileSync(source, "#!/usr/bin/env bun\nconsole.log(process.cwd());\n", { mode: 0o755 });
  writeFileSync(join(root, ".gitignore"), "node_modules/\nbuild/\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "agentvoice",
      workspaces: ["fixture-dep"],
      dependencies: { "fixture-dep": "workspace:*" },
      scripts: {
        "cli:install": JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts[
          "cli:install"
        ],
      },
    }),
  );
  writeFileSync(join(root, "fixture-dep/package.json"), '{"name":"fixture-dep","version":"1.0.0"}');
  writeFileSync(
    join(commands, "codex"),
    '#!/bin/bash\nprintf invoked > "$FIXTURE_BASE/codex-called"\nexit 99\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(commands, "clang"),
    `#!/bin/bash
printf built > "$FIXTURE_BASE/compiler-called"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'fixture native library' > "$1"; break; fi
  shift
done
if [ -n "$FIXTURE_CHANGE_SOURCE" ]; then printf '\\n// changed' >> "$FIXTURE_ROOT/src/main.ts"; fi
if [ -n "$FIXTURE_CLAIM_COMMAND" ]; then printf 'independent command' > "$FIXTURE_BASE/bin/agentvoice"; fi
exit "$FIXTURE_COMPILER_EXIT"
`,
    { mode: 0o755 },
  );
  function command(argv: string[]) {
    const result = Bun.spawnSync(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  // Local workspace dependency only: real frozen Bun behavior without registry/network use.
  command([process.execPath, "install", "--lockfile-only", "--ignore-scripts"]);
  command(["git", "init", "-q"]);
  command(["git", "config", "user.name", "Fixture"]);
  command(["git", "config", "user.email", "fixture@example.invalid"]);
  command(["git", "config", "core.hooksPath", "/dev/null"]);
  command(["git", "remote", "add", "origin", "git@github.com:possibilities/agentvoice.git"]);
  function commit() {
    command(["git", "add", "."]);
    command(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    return command(["git", "rev-parse", "HEAD"]);
  }
  const sha = commit();
  async function run(
    args = ["--install", "--command-only"],
    overrides: Record<string, string | undefined> = {},
  ) {
    const child = Bun.spawn(["/bin/bash", join(root, "scripts/install.sh"), ...args], {
      cwd: base,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(existsSync(join(base, "codex-called"))).toBe(false);
    return { code, out, err };
  }
  async function runService(failure?: string) {
    const script = `
      const { install } = await import(process.env["FIXTURE_ROOT"] + "/scripts/install.ts");
      const { VoiceService, servicePaths } = await import(process.env["FIXTURE_ROOT"] + "/src/service.ts");
      const { appendFileSync } = await import("node:fs");
      let loaded = false;
      const base = process.env["FIXTURE_BASE"];
      const options = {
        home: base, stateDir: base + "/service-state", uid: process.getuid(),
        bun: process.execPath, entrypoint: process.env["FIXTURE_ROOT"] + "/src/main.ts", env: process.env,
        launchctl: async (args) => {
          appendFileSync(base + "/launchctl-calls", JSON.stringify(args) + "\\n");
          if (args[0] === process.env["FIXTURE_SERVICE_FAILURE"]) return { code: 5, out: "", err: "fixture service failure" };
          if (args[0] === "print") return loaded
            ? { code: 0, out: "path = " + servicePaths(options).plist + "\\nstate = running\\n", err: "" }
            : { code: 113, out: "", err: "missing" };
          if (args[0] === "bootstrap") loaded = true;
          if (args[0] === "bootout") loaded = false;
          return { code: 0, out: "", err: "" };
        },
      };
      await install(new VoiceService(options));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: base,
      env: { ...env, FIXTURE_SERVICE_FAILURE: failure },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(existsSync(join(base, "codex-called"))).toBe(false);
    return { code, out, err };
  }
  return {
    base,
    runService,
    root,
    bin,
    state,
    source,
    commands,
    env,
    sha,
    run,
    command,
    commit,
    target: join(bin, "agentvoice"),
    receipt: join(state, "deployed-sha"),
  };
}

describe("command-only editable installer (isolated checkouts, no microphone or inference)", () => {
  test("the package alias invokes the same installer", () => {
    const f = fixture();
    f.command([process.execPath, "run", "cli:install", "--command-only"]);
    expect(readlinkSync(f.target)).toBe(f.source);
    expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
    expect(existsSync(join(f.base, "codex-called"))).toBe(false);
  });

  test("XDG state fallback stays inside the configured disposable state root", async () => {
    const f = fixture();
    const result = await f.run(undefined, { AGENTVOICE_INSTALL_STATE_DIR: undefined });
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(join(f.base, "xdg-state/agentvoice/deployed-sha"), "utf8")).toBe(
      `${f.sha}\n`,
    );
    expect(readdirSync(f.state)).toEqual([]);
  });

  test("a command claimed during the build is rechecked and preserved", async () => {
    const f = fixture();
    const result = await f.run(undefined, { FIXTURE_CLAIM_COMMAND: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("refusing unrelated command");
    expect(readFileSync(f.target, "utf8")).toBe("independent command");
    expect(readdirSync(f.state)).toEqual([]);
  });

  test("installs, reruns, records a commit, and the linked entrypoint preserves caller cwd", async () => {
    const f = fixture();
    const lock = readFileSync(join(f.root, "bun.lock"), "utf8");
    for (let count = 0; count < 2; count++) {
      const result = await f.run();
      expect(result.code, result.err).toBe(0);
      expect(readlinkSync(f.target)).toBe(f.source);
      expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
      expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
      expect(readdirSync(f.state)).toEqual(["deployed-sha"]);
      expect(readdirSync(f.bin)).toEqual(["agentvoice"]);
      expect(readFileSync(join(f.root, "bun.lock"), "utf8")).toBe(lock);
    }
    const linked = Bun.spawnSync([f.target], { cwd: f.base, env: f.env });
    expect(linked.exitCode).toBe(0);
    expect(linked.stdout.toString().trim()).toBe(f.base);
    expect(existsSync(join(f.base, "xdg-state"))).toBe(false);
  });

  test("help and invalid args have no install side effects", async () => {
    const f = fixture();
    for (const [args, code] of [
      [[], 2],
      [["--help"], 0],
      [["--uninstall"], 2],
      [["--install", "--help"], 2],
    ] as const) {
      expect((await f.run([...args])).code).toBe(code);
    }
    expect(readdirSync(f.bin)).toEqual([]);
    expect(readdirSync(f.state)).toEqual([]);
    expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
  });

  for (const kind of [
    "file",
    "directory",
    "dangling-link",
    "foreign-origin",
    "other-checkout-no-receipt",
  ]) {
    test(`refuses an unowned command: ${kind}`, async () => {
      const f = fixture();
      if (kind === "file") writeFileSync(f.target, "user command");
      if (kind === "directory") mkdirSync(f.target);
      if (kind === "dangling-link") symlinkSync(join(f.base, "absent"), f.target);
      if (kind === "foreign-origin" || kind === "other-checkout-no-receipt") {
        const other = fixture();
        if (kind === "foreign-origin")
          other.command([
            "git",
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/other.git",
          ]);
        symlinkSync(other.source, f.target);
      }
      expect((await f.run()).code).toBe(1);
      expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
      expect(readdirSync(f.state)).toEqual([]);
    });
  }

  test("a receipt-proved source link can move between checkouts", async () => {
    const f = fixture();
    const previous = fixture();
    symlinkSync(previous.source, f.target);
    writeFileSync(f.receipt, `${previous.sha}\n`, { mode: 0o600 });
    const result = await f.run();
    expect(result.code, result.err).toBe(0);
    expect(readlinkSync(f.target)).toBe(f.source);
    expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
  });

  for (const kind of [
    "dirty",
    "untracked",
    "missing-codex",
    "bad-codex-path",
    "missing-compiler",
    "source-mode",
    "relative-bin",
    "symlink-bin",
    "writable-bin",
    "symlink-build",
    "lock",
  ]) {
    test(`preflight refuses ${kind} before build/publication`, async () => {
      const f = fixture();
      const overrides: Record<string, string> = {};
      if (kind === "dirty") writeFileSync(f.source, "dirty");
      if (kind === "untracked") writeFileSync(join(f.root, "untracked"), "user content");
      if (kind === "missing-codex") unlinkSync(join(f.commands, "codex"));
      if (kind === "bad-codex-path") overrides["CODEX_PATH"] = join(f.base, "nonexistent");
      if (kind === "missing-compiler") unlinkSync(join(f.commands, "clang"));
      if (kind === "source-mode") chmodSync(f.source, 0o666);
      if (kind === "relative-bin") overrides["AGENTVOICE_INSTALL_BIN_DIR"] = "relative";
      if (kind === "symlink-bin") {
        renameSync(f.bin, `${f.bin}-real`);
        symlinkSync(`${f.bin}-real`, f.bin);
      }
      if (kind === "writable-bin") chmodSync(f.bin, 0o777);
      if (kind === "symlink-build") symlinkSync(f.bin, join(f.root, "build"));
      if (kind === "lock") mkdirSync(join(f.state, ".install-lock"));
      expect((await f.run(undefined, overrides)).code).toBe(1);
      expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
      expect(existsSync(f.target)).toBe(false);
      expect(existsSync(f.receipt)).toBe(false);
    });
  }

  for (const kind of ["malformed", "hardlinked", "symlink", "permissions", "orphan"]) {
    test(`refuses unsafe receipt: ${kind}`, async () => {
      const f = fixture();
      if (kind !== "orphan") symlinkSync(f.source, f.target);
      writeFileSync(f.receipt, kind === "malformed" ? "not a sha\n" : `${f.sha}\n`, {
        mode: 0o600,
      });
      if (kind === "hardlinked") linkSync(f.receipt, join(f.base, "receipt-copy"));
      if (kind === "symlink") {
        renameSync(f.receipt, join(f.base, "receipt-copy"));
        symlinkSync(join(f.base, "receipt-copy"), f.receipt);
      }
      if (kind === "permissions") chmodSync(f.receipt, 0o644);
      expect((await f.run()).code).toBe(1);
      expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
    });
  }

  test("failed native rebuild preserves the installed library, command and receipt", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    const nativeDir = join(f.root, "build/native", `${process.platform}-${process.arch}`);
    const library = join(
      nativeDir,
      `libagentvoice_audio.${process.platform === "darwin" ? "dylib" : "so"}`,
    );
    writeFileSync(library, "previous usable library");
    const result = await f.run(undefined, { FIXTURE_COMPILER_EXIT: "7" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("command link not changed");
    expect(readFileSync(library, "utf8")).toBe("previous usable library");
    expect(readdirSync(nativeDir)).toEqual([library.split("/").at(-1)!]);
    expect(readlinkSync(f.target)).toBe(f.source);
    expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
    expect(readdirSync(f.state)).toEqual(["deployed-sha"]);
  });

  test("frozen dependency failure never reaches the compiler or publishes a command", async () => {
    const f = fixture();
    const lock = join(f.root, "bun.lock");
    writeFileSync(lock, "invalid lockfile\n");
    f.commit();
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.err).toContain("frozen");
    expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(f.state)).toEqual([]);
  });

  test("a source change during the build prevents publication", async () => {
    const f = fixture();
    expect((await f.run(undefined, { FIXTURE_CHANGE_SOURCE: "1" })).code).toBe(1);
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(f.state)).toEqual([]);
  });

  test("same-checkout updates refresh the receipt and warn when another command shadows it", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    writeFileSync(join(f.root, "note"), "new commit");
    const sha = f.commit();
    writeFileSync(join(f.commands, "agentvoice"), "#!/bin/bash\nexit 99\n", { mode: 0o755 });
    const result = await f.run();
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(f.receipt, "utf8")).toBe(`${sha}\n`);
    expect(result.err).toContain("PATH does not select this command");
    expect(readFileSync(join(f.commands, "agentvoice"), "utf8")).toContain("exit 99");
  });
});

test("installer publishes command then registers default service with a fake launchctl runner", async () => {
  const f = fixture();
  const result = await f.runService();
  expect(result.code, result.err).toBe(0);
  expect(readlinkSync(f.target)).toBe(f.source);
  expect(readFileSync(f.receipt, "utf8")).toBe(`${f.sha}\n`);
  const plist = readFileSync(
    join(f.base, "Library/LaunchAgents/io.arthack.agentvoice.server.plist"),
    "utf8",
  );
  expect(plist).toContain(f.source);
  expect(plist).toContain("<string>server</string>");
  expect(readFileSync(join(f.base, "launchctl-calls"), "utf8")).toContain("bootstrap");
});

test("service failure is reported distinctly after successful command publication", async () => {
  const f = fixture();
  const result = await f.runService("bootstrap");
  expect(result.code).toBe(1);
  expect(result.err).toContain("Command installed, but LaunchAgent installation failed");
  expect(readlinkSync(f.target)).toBe(f.source);
  expect(existsSync(join(f.base, "Library/LaunchAgents/io.arthack.agentvoice.server.plist"))).toBe(
    false,
  );
});
