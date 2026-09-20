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
const oldRevision = "1".repeat(40);
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
  const applications = join(base, "Applications");
  for (const dir of [
    root,
    bin,
    state,
    commands,
    applications,
    join(root, "scripts"),
    join(root, "src"),
    join(root, "src/core"),
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
  for (const name of [
    "service.ts",
    "service-handoff.ts",
    "service-runtime.ts",
    "macos-app.ts",
    "paths.ts",
    "private-files.ts",
  ]) {
    copyFileSync(join(repository, "src", name), join(root, "src", name));
  }
  copyFileSync(join(repository, "src/core/thread-lock.ts"), join(root, "src/core/thread-lock.ts"));
  copyFileSync(
    join(repository, "src/core/owned-processes.ts"),
    join(root, "src/core/owned-processes.ts"),
  );
  for (const name of ["bun", "git", "dirname", "bash"]) {
    symlinkSync(name === "bun" ? process.execPath : Bun.which(name)!, join(commands, name));
  }
  for (const name of ["swift", "iconutil", "codesign"]) {
    symlinkSync("/usr/bin/true", join(commands, name));
  }
  const env: Record<string, string> = {
    PATH: commands,
    AGENTVOICE_INSTALL_BIN_DIR: bin,
    AGENTVOICE_INSTALL_STATE_DIR: state,
    AGENTVOICE_INSTALL_APP_DIR: applications,
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
  writeFileSync(join(root, ".gitignore"), "node_modules/\nbuild/\ndist/\n");
  writeFileSync(
    join(root, "scripts/build-macos-app.sh"),
    `#!/bin/bash
set -euo pipefail
candidate="$FIXTURE_ROOT/dist/AgentVoice.app"
/bin/mkdir -p "$candidate/Contents/MacOS"
sha=$(git -C "$FIXTURE_ROOT" rev-parse HEAD)
/usr/bin/printf '{"CFBundleIdentifier":"io.arthack.agentvoice.menu","AgentVoiceInstaller":"agentvoice/scripts/install.sh","AgentVoiceSourceRevision":"%s","AgentVoiceMenuControlProtocol":"1"}' "$sha" > "$candidate/Contents/Info.plist"
/usr/bin/printf signed > "$candidate/Contents/MacOS/AgentVoice"
/bin/chmod 755 "$candidate/Contents/MacOS/AgentVoice"
`,
    { mode: 0o755 },
  );
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
        packageRuntime: true,
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
      await install(new VoiceService(options), false);
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
  function writeMenuApp(revision: string, controlProtocol = "1") {
    const app = join(applications, "AgentVoice.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      JSON.stringify({
        CFBundleIdentifier: "io.arthack.agentvoice.menu",
        AgentVoiceInstaller: "agentvoice/scripts/install.sh",
        AgentVoiceSourceRevision: revision,
        ...(controlProtocol ? { AgentVoiceMenuControlProtocol: controlProtocol } : {}),
      }),
    );
    writeFileSync(join(app, "Contents", "MacOS", "AgentVoice"), "signed", { mode: 0o755 });
    return app;
  }
  async function runMenu(
    options: {
      quitMenu?: boolean;
      quitResult?: "success" | "refuse" | "timeout" | "premature" | "lost";
      launchResult?: "success" | "fail";
      installResult?: "success" | "fail";
    } = {},
  ) {
    const script = `
      const { install } = await import(process.env["FIXTURE_ROOT"] + "/scripts/install.ts");
      const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
      const base = process.env["FIXTURE_BASE"];
      const checks = {
        plistValue(app, key) { return JSON.parse(readFileSync(app + "/Contents/Info.plist", "utf8"))[key]; },
        verifySignature(app) {
          if (readFileSync(app + "/Contents/MacOS/AgentVoice", "utf8") !== "signed") throw new Error("invalid signature");
          const revision = JSON.parse(readFileSync(app + "/Contents/Info.plist", "utf8")).AgentVoiceSourceRevision;
          if (process.env["FIXTURE_INSTALL_RESULT"] === "fail" && app === base + "/Applications/AgentVoice.app" && revision !== "${oldRevision}") {
            throw new Error("fixture final app verification failure");
          }
        },
        running(executable) {
          return existsSync(base + "/menu-running") && readFileSync(base + "/menu-running", "utf8") === executable;
        },
      };
      const lifecycle = {
        async requestQuit(executable, revision) {
          appendFileSync(base + "/menu-calls", "quit " + executable + " " + revision + "\\n");
          if (process.env["FIXTURE_QUIT_RESULT"] === "refuse") throw new Error("fixture busy refusal");
          if (process.env["FIXTURE_QUIT_RESULT"] === "timeout") throw new Error("AgentVoice menu did not quit before the update timeout");
          if (process.env["FIXTURE_QUIT_RESULT"] === "lost") {
            rmSync(base + "/menu-running", { force: true });
            throw new Error("connection closed before acknowledgement");
          }
          if (process.env["FIXTURE_QUIT_RESULT"] !== "premature") rmSync(base + "/menu-running", { force: true });
        },
        async launch(app) {
          appendFileSync(base + "/menu-calls", "launch " + app + "\\n");
          if (process.env["FIXTURE_LAUNCH_RESULT"] === "fail") throw new Error("fixture launch failure");
          writeFileSync(base + "/menu-running", app + "/Contents/MacOS/AgentVoice");
        },
      };
      await install(false, true, {
        menuOnly: true,
        quitMenu: process.env["FIXTURE_QUIT_MENU"] === "1",
        appChecks: checks,
        appLifecycle: lifecycle,
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: base,
      env: {
        ...env,
        FIXTURE_QUIT_MENU: options.quitMenu ? "1" : "0",
        FIXTURE_QUIT_RESULT: options.quitResult ?? "success",
        FIXTURE_LAUNCH_RESULT: options.launchResult ?? "success",
        FIXTURE_INSTALL_RESULT: options.installResult ?? "success",
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(15_000),
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  }
  return {
    base,
    runService,
    root,
    bin,
    state,
    applications,
    source,
    commands,
    env,
    sha,
    run,
    runMenu,
    writeMenuApp,
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
    expect(readdirSync(f.state)).toEqual([".install-lock"]);
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
      expect(readdirSync(f.state).sort()).toEqual([".install-lock", "deployed-sha"]);
      expect(readdirSync(f.bin)).toEqual(["agentvoice"]);
      expect(readFileSync(join(f.root, "bun.lock"), "utf8")).toBe(lock);
    }
    const linked = Bun.spawnSync([f.target], { cwd: f.base, env: f.env });
    expect(linked.exitCode).toBe(0);
    expect(linked.stdout.toString().trim()).toBe(f.base);
    expect(existsSync(join(f.base, "xdg-state"))).toBe(false);
  });

  test("the installer lock is kernel-released when its owner is killed", async () => {
    const f = fixture();
    expect((await f.run()).code).toBe(0);
    const lock = join(f.state, ".install-lock");
    expect(statSync(lock).isFile()).toBe(true);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    const holder = Bun.spawn(
      [process.execPath, join(repository, "tests/fixtures/lock-holder.ts"), "--file", lock],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    try {
      const busy = await f.run();
      expect(busy.code).toBe(1);
      expect(busy.err).toContain("Another AgentVoice installer is already in progress");
      holder.kill("SIGKILL");
      await holder.exited;
      expect((await f.run()).code).toBe(0);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  test("help and invalid args have no install side effects", async () => {
    const f = fixture();
    for (const [args, code] of [
      [[], 2],
      [["--help"], 0],
      [["--uninstall"], 2],
      [["--install", "--help"], 2],
      [["--install", "--command-only", "--quit-menu"], 2],
      [["--install", "--command-only", "--menu-only"], 2],
      [["--install", "--quit-menu", "--quit-menu"], 2],
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
    expect(readdirSync(f.state).sort()).toEqual([".install-lock", "deployed-sha"]);
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
    expect(readdirSync(f.state)).toEqual([".install-lock"]);
  });

  test("a source change during the build prevents publication", async () => {
    const f = fixture();
    expect((await f.run(undefined, { FIXTURE_CHANGE_SOURCE: "1" })).code).toBe(1);
    expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(f.state)).toEqual([".install-lock"]);
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

describe("menu-only installer lifecycle (disposable app, no server or call)", () => {
  test("installs an absent app without quitting, launching, or touching the command and server", async () => {
    const f = fixture();
    const result = await f.runMenu({ quitMenu: true });
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(f.applications, "AgentVoice.app"))).toBe(true);
    expect(existsSync(join(f.base, "menu-calls"))).toBe(false);
    expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
    expect(existsSync(join(f.base, "compiler-called"))).toBe(false);
    expect(existsSync(f.target)).toBe(false);
    expect(existsSync(f.receipt)).toBe(false);
    expect(result.out).toContain("server and any call were left unchanged");
  });

  test("opt-in quits and reopens only the exact previously running menu app", async () => {
    const f = fixture();
    const app = f.writeMenuApp(oldRevision);
    const executable = join(app, "Contents", "MacOS", "AgentVoice");
    writeFileSync(join(f.base, "menu-running"), executable);

    const result = await f.runMenu({ quitMenu: true });
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(join(f.base, "menu-calls"), "utf8")).toBe(
      `quit ${executable} ${oldRevision}\nlaunch ${app}\n`,
    );
    expect(readFileSync(join(f.base, "menu-running"), "utf8")).toBe(executable);
    expect(
      JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
        .AgentVoiceSourceRevision,
    ).toBe(f.sha);
    expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
    expect(existsSync(f.target)).toBe(false);
  });

  test("running updates remain opt-in and legacy apps require one manual quit", async () => {
    for (const [quitMenu, protocol, expected] of [
      [false, "1", "rerun with --quit-menu"],
      [true, "", "cannot quit itself for an update"],
    ] as const) {
      const f = fixture();
      const app = f.writeMenuApp(oldRevision, protocol);
      writeFileSync(join(f.base, "menu-running"), join(app, "Contents", "MacOS", "AgentVoice"));
      const result = await f.runMenu({ quitMenu });
      expect(result.code).toBe(1);
      expect(result.err).toContain(expected);
      expect(
        JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
          .AgentVoiceSourceRevision,
      ).toBe(oldRevision);
      expect(existsSync(join(f.base, "menu-calls"))).toBe(false);
      expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
    }
  });

  test("quit refusal, timeout, or premature completion preserves the old app and never relaunches", async () => {
    for (const quitResult of ["refuse", "timeout", "premature"] as const) {
      const f = fixture();
      const app = f.writeMenuApp(oldRevision);
      const executable = join(app, "Contents", "MacOS", "AgentVoice");
      writeFileSync(join(f.base, "menu-running"), executable);
      const result = await f.runMenu({ quitMenu: true, quitResult });
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        quitResult === "refuse"
          ? "fixture busy refusal"
          : quitResult === "timeout"
            ? "did not quit before the update timeout"
            : "returned before the running app quit",
      );
      expect(readFileSync(join(f.base, "menu-calls"), "utf8")).toBe(
        `quit ${executable} ${oldRevision}\n`,
      );
      expect(
        JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
          .AgentVoiceSourceRevision,
      ).toBe(oldRevision);
      expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
    }
  });

  test("a stopped app stays stopped, while relaunch failure reports the installed update", async () => {
    const stopped = fixture();
    const stoppedApp = stopped.writeMenuApp(oldRevision);
    const stoppedResult = await stopped.runMenu({ quitMenu: true });
    expect(stoppedResult.code, stoppedResult.err).toBe(0);
    expect(existsSync(join(stopped.base, "menu-calls"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(stoppedApp, "Contents", "Info.plist"), "utf8"))
        .AgentVoiceSourceRevision,
    ).toBe(stopped.sha);

    const failing = fixture();
    const app = failing.writeMenuApp(oldRevision);
    writeFileSync(join(failing.base, "menu-running"), join(app, "Contents", "MacOS", "AgentVoice"));
    const failedResult = await failing.runMenu({ quitMenu: true, launchResult: "fail" });
    expect(failedResult.code).toBe(1);
    expect(failedResult.err).toContain("but could not reopen it");
    expect(
      JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
        .AgentVoiceSourceRevision,
    ).toBe(failing.sha);
    expect(existsSync(join(failing.base, "launchctl-calls"))).toBe(false);
  });

  test("publication failure restores and reopens the previously running old app", async () => {
    const f = fixture();
    const app = f.writeMenuApp(oldRevision);
    const executable = join(app, "Contents", "MacOS", "AgentVoice");
    writeFileSync(join(f.base, "menu-running"), executable);

    const result = await f.runMenu({ quitMenu: true, installResult: "fail" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("reopened the preserved AgentVoice menu app");
    expect(readFileSync(join(f.base, "menu-calls"), "utf8")).toBe(
      `quit ${executable} ${oldRevision}\nlaunch ${app}\n`,
    );
    expect(
      JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
        .AgentVoiceSourceRevision,
    ).toBe(oldRevision);
    expect(readFileSync(join(f.base, "menu-running"), "utf8")).toBe(executable);
    expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
  });

  test("a lost quit acknowledgement refuses the update and reopens the preserved old app", async () => {
    const f = fixture();
    const app = f.writeMenuApp(oldRevision);
    const executable = join(app, "Contents", "MacOS", "AgentVoice");
    writeFileSync(join(f.base, "menu-running"), executable);

    const result = await f.runMenu({ quitMenu: true, quitResult: "lost" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("connection closed before acknowledgement");
    expect(result.err).toContain("reopened the preserved AgentVoice menu app");
    expect(readFileSync(join(f.base, "menu-calls"), "utf8")).toBe(
      `quit ${executable} ${oldRevision}\nlaunch ${app}\n`,
    );
    expect(
      JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))
        .AgentVoiceSourceRevision,
    ).toBe(oldRevision);
    expect(readFileSync(join(f.base, "menu-running"), "utf8")).toBe(executable);
    expect(existsSync(join(f.base, "launchctl-calls"))).toBe(false);
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
  expect(plist).toContain(
    "<key>AssociatedBundleIdentifiers</key><array><string>io.arthack.agentvoice</string></array>",
  );
  const runtimeInfo = readFileSync(
    join(f.base, "service-state/default/service/runtime/AgentVoice.app/Contents/Info.plist"),
    "utf8",
  );
  expect(runtimeInfo).toContain(
    "<key>CFBundleIdentifier</key><string>io.arthack.agentvoice</string>",
  );
  expect(runtimeInfo).toContain("NSMicrophoneUsageDescription");
  expect(runtimeInfo).toContain("NSLocalNetworkUsageDescription");
  expect(runtimeInfo).toContain(
    "AgentVoice connects to trusted devices and development services on your local network when you ask it to.",
  );
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
