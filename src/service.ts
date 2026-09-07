import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type Environ, stateDirectory } from "./paths.ts";
import { ownedDirectory, ownedFile, safeAncestors } from "./private-files.ts";

export const SERVICE_LABEL = "dev.agentvoice.default";
type Result = { code: number; out: string; err: string };
export type Launchctl = (args: string[]) => Promise<Result>;
export interface ServiceOptions {
  home: string;
  stateDir: string;
  uid: number;
  bun: string;
  entrypoint: string;
  env: Environ;
  launchctl: Launchctl;
}

async function launchctl(args: string[]): Promise<Result> {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(args[0] === "bootout" ? 75_000 : 15_000),
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

export function serviceOptions(entrypoint: string): ServiceOptions {
  if (process.platform !== "darwin") throw new Error("LaunchAgents require macOS");
  const uid = process.getuid?.();
  if (!uid) throw new Error("Run as the logged-in user, not root");
  const home = homedir();
  return {
    home,
    stateDir: stateDirectory(process.env, home),
    uid,
    bun: process.execPath,
    entrypoint,
    env: process.env,
    launchctl,
  };
}

export function servicePaths(options: ServiceOptions) {
  const directory = join(options.home, "Library", "LaunchAgents");
  return {
    directory,
    plist: join(directory, `${SERVICE_LABEL}.plist`),
    logs: join(options.stateDir, "default", "service"),
  };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function xml(text: string): string {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13)
      throw new Error("Invalid XML control character");
  }
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function servicePlist(options: ServiceOptions): string {
  const { logs } = servicePaths(options);
  for (const path of [options.home, options.stateDir, options.bun, options.entrypoint])
    if (!isAbsolute(path)) throw new Error("LaunchAgent paths must be absolute");
  // launchd does not inherit the installing shell. Carry only launch inputs,
  // preserving CODEX_HOME omission and never copying credentials or arbitrary env.
  const env: Environ = {
    HOME: options.home,
    PATH: options.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of [
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "CODEX_HOME",
    "CODEX_PATH",
    "AGENTROLES_HOME",
  ])
    if (options.env[key] !== undefined) env[key] = options.env[key];
  const body = `<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${[options.bun, options.entrypoint, "server"].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.home)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value!)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
</dict></plist>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- agentvoice-launchagent-v1 ${digest(body)} -->\n${body}`;
}

function readManaged(path: string): string | undefined {
  if (!ownedFile(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const match =
    /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!-- agentvoice-launchagent-v1 ([a-f0-9]{64}) -->\n([\s\S]*)$/.exec(
      text,
    );
  if (
    !match ||
    digest(match[2]!) !== match[1] ||
    !match[2]!.includes(`<key>Label</key><string>${SERVICE_LABEL}</string>`)
  )
    throw new Error(`Refusing unrelated or edited LaunchAgent: ${path}`);
  return text;
}

function installedLogs(plist: string): string[] {
  return ["StandardOutPath", "StandardErrorPath"].map((key) => {
    const value = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist)?.[1];
    if (!value) throw new Error("Installed LaunchAgent has no log path");
    return value
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  });
}

function prepareLogs(plist: string): void {
  for (const path of installedLogs(plist)) {
    ownedDirectory(dirname(path));
    if (!ownedFile(path)) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  }
}

function atomicWrite(path: string, text: string) {
  const stage = join(dirname(path), `.${SERVICE_LABEL}-${randomUUID()}.tmp`);
  try {
    writeFileSync(stage, text, { flag: "wx", mode: 0o600 });
    renameSync(stage, path);
  } finally {
    if (lstatSync(stage, { throwIfNoEntry: false })) unlinkSync(stage);
  }
}

export class VoiceService {
  constructor(private readonly options: ServiceOptions) {}
  async preflight(): Promise<void> {
    const { directory, plist, logs } = servicePaths(this.options);
    safeAncestors(directory);
    safeAncestors(logs);
    const previous = readManaged(plist);
    if ((await this.loaded()) && !previous)
      throw new Error("Refusing a loaded job without an owned installation");
    servicePlist(this.options);
    for (const name of ["stdout.log", "stderr.log"]) ownedFile(join(logs, name));
  }
  private get target() {
    return `gui/${this.options.uid}/${SERVICE_LABEL}`;
  }
  private async run(args: string[]) {
    const result = await this.options.launchctl(args);
    if (result.code !== 0)
      throw new Error(`launchctl ${args[0]} failed (${result.code}): ${result.err.trim()}`);
    return result;
  }
  private async loaded(): Promise<Result | undefined> {
    const result = await this.options.launchctl(["print", this.target]);
    if (result.code === 113) return undefined;
    if (result.code !== 0)
      throw new Error(`Cannot inspect LaunchAgent (${result.code}): ${result.err.trim()}`);
    const expected = servicePaths(this.options).plist;
    const path = /^\s*path = (.+)$/m.exec(result.out)?.[1];
    if (path !== expected)
      throw new Error(`Refusing a loaded job with an unrelated plist: ${this.target}`);
    return result;
  }
  async status(): Promise<string> {
    const { directory, plist, logs } = servicePaths(this.options);
    safeAncestors(directory);
    const installed = readManaged(plist);
    const loaded = await this.loaded();
    if (loaded && !installed) throw new Error("Loaded LaunchAgent has no owned installation");
    const state = loaded ? (/^\s*state = (.+)$/m.exec(loaded.out)?.[1] ?? "loaded") : "not loaded";
    return `${SERVICE_LABEL}: ${installed ? state : "not installed"}\nPlist: ${plist}\nLogs: ${installed ? installedLogs(installed).join(", ") : logs}\n`;
  }
  async change(action: "install" | "restart" | "remove"): Promise<void> {
    const { directory, plist, logs } = servicePaths(this.options);
    safeAncestors(directory);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    const lock = join(directory, `.${SERVICE_LABEL}.lock`);
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new Error(
        `Service operation lock exists: ${lock}; check for another operation before removing a stale lock`,
      );
    }
    try {
      const previous = readManaged(plist);
      const loaded = await this.loaded();
      if (loaded && !previous)
        throw new Error("Refusing a loaded job without an owned installation");
      if (action !== "install" && !previous) {
        if (action === "remove") return;
        throw new Error("LaunchAgent is not installed; run scripts/install.sh --install");
      }
      if (action === "install") {
        const next = servicePlist(this.options);
        ownedDirectory(this.options.stateDir);
        ownedDirectory(join(this.options.stateDir, "default"));
        ownedDirectory(logs);
        prepareLogs(next);
        if (loaded) await this.run(["bootout", this.target]);
        let published = false;
        try {
          if (readManaged(plist) !== previous)
            throw new Error("LaunchAgent changed during installation");
          atomicWrite(plist, next);
          published = true;
          await this.run(["enable", this.target]);
          await this.run(["bootstrap", `gui/${this.options.uid}`, plist]);
        } catch (error) {
          // Preserve the prior registration if publication could not be loaded.
          try {
            if (published) {
              if (previous) atomicWrite(plist, previous);
              else unlinkSync(plist);
            }
            if (loaded && readManaged(plist) === previous) {
              prepareLogs(previous!);
              await this.run(["bootstrap", `gui/${this.options.uid}`, plist]);
            }
          } catch (restore) {
            throw new AggregateError(
              [error, restore],
              "LaunchAgent install and restoration failed",
            );
          }
          throw error;
        }
      } else if (action === "remove") {
        if (loaded) await this.run(["bootout", this.target]);
        unlinkSync(plist);
      } else {
        prepareLogs(previous!);
        if (loaded) await this.run(["bootout", this.target]);
        await this.run(["enable", this.target]);
        await this.run(["bootstrap", `gui/${this.options.uid}`, plist]);
      }
    } finally {
      rmdirSync(lock);
    }
  }
}
