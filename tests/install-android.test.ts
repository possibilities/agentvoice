import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = dirname(import.meta.dir);
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function remoteFixture(contents = '#!/bin/bash\n[ "$' + '{1:-}" = --help ]\n') {
  const base = mkdtempSync(join(tmpdir(), "agentvoice-android-remote-test-"));
  temporary.push(base);
  const home = join(base, "home");
  const bundle = join(base, "bundle");
  const commands = join(base, "commands");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bundle, { mode: 0o700 });
  mkdirSync(commands, { mode: 0o700 });
  writeFileSync(join(commands, "uname"), "#!/bin/bash\nprintf 'aarch64\\n'\n", { mode: 0o700 });
  writeFileSync(
    join(commands, "stat"),
    `#!/bin/bash
[ "$1" = -c ] || exit 64
case "$2" in
  %u) exec /usr/bin/stat -f %u "$3" ;;
  %a) exec /usr/bin/stat -f %Lp "$3" ;;
  %h) exec /usr/bin/stat -f %l "$3" ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o700 },
  );
  for (const name of ["codex", "termux-open-url"])
    writeFileSync(join(commands, name), "#!/bin/bash\nprintf invoked >&2\nexit 99\n", {
      mode: 0o700,
    });
  const sha = hash(contents);
  const source = "1".repeat(40);
  writeFileSync(join(bundle, "agentvoice"), contents, { mode: 0o700 });
  writeFileSync(
    join(bundle, "manifest"),
    `agentvoice-android-v1\nsource-sha=${source}\nartifact-sha256=${sha}\n`,
    { mode: 0o600 },
  );
  const target = join(home, ".local/bin/agentvoice");
  const receipt = join(home, ".local/state/agentvoice/android-deployed");
  function run() {
    return Bun.spawnSync(
      ["/bin/bash", join(repository, "scripts/install-android-remote"), bundle],
      {
        env: {
          PATH: `${commands}:/usr/bin:/bin:/sbin`,
          HOME: home,
          ANDROID_ROOT: "/system",
          PREFIX: "/data/data/com.termux/files/usr",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }
  return { base, home, bundle, commands, contents, sha, source, target, receipt, run };
}

describe("device-side Android standalone publication", () => {
  test("adopts only an exact unreceipted binary, writes a private receipt, and reruns", () => {
    const f = remoteFixture();
    mkdirSync(dirname(f.target), { recursive: true, mode: 0o700 });
    writeFileSync(f.target, f.contents, { mode: 0o700 });
    for (let count = 0; count < 2; count++) {
      const result = f.run();
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(f.target, "utf8")).toBe(f.contents);
      expect(statSync(f.target).mode & 0o777).toBe(0o700);
      expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
      expect(readFileSync(f.receipt, "utf8")).toBe(
        `agentvoice-android-v1\nsource-sha=${f.source}\nartifact-sha256=${f.sha}\n`,
      );
    }
  });

  test("upgrades a receipt-correlated binary with staged verified publication", () => {
    const f = remoteFixture('#!/bin/bash\n[ "$' + '{1:-}" = --help ]\n# successor\n');
    const prior = "#!/bin/bash\nexit 23\n";
    const priorSha = hash(prior);
    mkdirSync(dirname(f.target), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(f.receipt), { recursive: true, mode: 0o700 });
    writeFileSync(f.target, prior, { mode: 0o700 });
    writeFileSync(
      f.receipt,
      `agentvoice-android-v1\nsource-sha=${"2".repeat(40)}\nartifact-sha256=${priorSha}\n`,
      { mode: 0o600 },
    );
    const result = f.run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe(f.contents);
    expect(readFileSync(f.receipt, "utf8")).toContain(`artifact-sha256=${f.sha}\n`);
  });

  test("refuses an unrelated unreceipted command without changing it", () => {
    const f = remoteFixture();
    mkdirSync(dirname(f.target), { recursive: true, mode: 0o700 });
    writeFileSync(f.target, "unrelated command\n", { mode: 0o700 });
    const result = f.run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing unrelated unreceipted command");
    expect(readFileSync(f.target, "utf8")).toBe("unrelated command\n");
    expect(existsSync(f.receipt)).toBe(false);
  });

  test("refuses malformed or contradicted receipts without changing the command", () => {
    const f = remoteFixture();
    mkdirSync(dirname(f.target), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(f.receipt), { recursive: true, mode: 0o700 });
    writeFileSync(f.target, "prior command\n", { mode: 0o700 });
    writeFileSync(f.receipt, "not a receipt\n", { mode: 0o600 });
    const malformed = f.run();
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr.toString()).toContain("malformed deployment receipt");
    expect(readFileSync(f.target, "utf8")).toBe("prior command\n");

    writeFileSync(
      f.receipt,
      `agentvoice-android-v1\nsource-sha=${"3".repeat(40)}\nartifact-sha256=${"4".repeat(64)}\n`,
      { mode: 0o600 },
    );
    const contradicted = f.run();
    expect(contradicted.exitCode).toBe(1);
    expect(contradicted.stderr.toString()).toContain("does not match its receipt");
    expect(readFileSync(f.target, "utf8")).toBe("prior command\n");
  });

  test("fails before publication when phone prerequisites or staged smoke checks fail", () => {
    const missing = remoteFixture();
    rmSync(join(missing.commands, "termux-open-url"));
    const prerequisite = missing.run();
    expect(prerequisite.exitCode).toBe(1);
    expect(prerequisite.stderr.toString()).toContain("termux-open-url is required");
    expect(existsSync(missing.target)).toBe(false);

    const broken = remoteFixture("#!/bin/bash\nexit 17\n");
    const smoke = broken.run();
    expect(smoke.exitCode).toBe(17);
    expect(existsSync(broken.target)).toBe(false);
    expect(existsSync(broken.receipt)).toBe(false);
  });
});

function dispatcherFixture() {
  const base = mkdtempSync(join(tmpdir(), "agentvoice-android-dispatch-test-"));
  temporary.push(base);
  const root = join(base, "checkout");
  const scripts = join(root, "scripts");
  const commands = join(base, "commands");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(commands);
  copyFileSync(join(repository, "scripts/install-android"), join(scripts, "install-android"));
  copyFileSync(
    join(repository, "scripts/install-android-remote"),
    join(scripts, "install-android-remote"),
  );
  chmodSync(join(scripts, "install-android"), 0o700);
  chmodSync(join(scripts, "install-android-remote"), 0o700);
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "package.json"), '{"scripts":{"android:build":"fixture"}}\n');
  writeFileSync(
    join(commands, "bun"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE_BASE/bun-calls"
if [ "$1" = --version ]; then printf '1.4.2\\n'; exit 0; fi
if [ "$1" = install ]; then exit 0; fi
if [ "$1" = run ] && [ "$2" = android:build ]; then
  mkdir -p dist
  printf '#!/bin/bash\\n[ "\${1:-}" = --help ]\\n' > dist/agentvoice-android-arm64
  chmod 700 dist/agentvoice-android-arm64
  exit 0
fi
exit 91
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(commands, "od"),
    "#!/bin/bash\nprintf ' 7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00 02 00 b7 00\\n'\n",
    { mode: 0o700 },
  );
  writeFileSync(
    join(commands, "ssh"),
    '#!/bin/bash\nprintf \'%s\\n\' "$*" > "$FIXTURE_BASE/ssh-call"\ntar -tf - > "$FIXTURE_BASE/archive"\n',
    { mode: 0o700 },
  );
  const env = {
    PATH: `${commands}:/usr/bin:/bin:/sbin`,
    FIXTURE_BASE: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("remote", "add", "origin", "git@github.com:possibilities/agentvoice.git");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  function run(args = ["--install", "--host", "smolbird"]) {
    return Bun.spawnSync(["/bin/bash", join(scripts, "install-android"), ...args], {
      cwd: base,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  return { base, root, env, run };
}

describe("Android deployment dispatcher", () => {
  test("builds from a clean checkout and sends the bounded bundle to the exact SSH target", () => {
    const f = dispatcherFixture();
    const result = f.run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(f.base, "bun-calls"), "utf8")).toBe(
      "--version\ninstall --frozen-lockfile\nrun android:build\n",
    );
    expect(readFileSync(join(f.base, "ssh-call"), "utf8")).toStartWith("-- smolbird set -eu;");
    expect(readFileSync(join(f.base, "archive"), "utf8").trim().split("\n").sort()).toEqual([
      "agentvoice",
      "install-remote",
      "manifest",
    ]);
  });

  test("rejects unsafe targets and dirty source before building or contacting SSH", () => {
    const unsafe = dispatcherFixture();
    expect(unsafe.run(["--install", "--host", "-oProxyCommand=bad"]).exitCode).toBe(1);
    expect(existsSync(join(unsafe.base, "bun-calls"))).toBe(false);
    expect(existsSync(join(unsafe.base, "ssh-call"))).toBe(false);

    const dirty = dispatcherFixture();
    writeFileSync(join(dirty.root, "untracked"), "dirty\n");
    const result = dirty.run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("checkout is dirty");
    expect(existsSync(join(dirty.base, "bun-calls"))).toBe(false);
    expect(existsSync(join(dirty.base, "ssh-call"))).toBe(false);
  });

  test("help and argument errors have no build or SSH side effects", () => {
    const f = dispatcherFixture();
    expect(f.run(["--help"]).exitCode).toBe(0);
    expect(f.run([]).exitCode).toBe(64);
    expect(f.run(["--install", "--host"]).exitCode).toBe(64);
    expect(existsSync(join(f.base, "bun-calls"))).toBe(false);
    expect(existsSync(join(f.base, "ssh-call"))).toBe(false);
  });
});
