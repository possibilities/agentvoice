/**
 * Server configuration: CLI flags over `server.yaml` over built-in defaults.
 * Options left unset are not sent to codex at all, so codex's own
 * configuration (`~/.codex/config.toml`) applies.
 */
import { isAbsolute, join, resolve } from "node:path";

export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export const APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export interface ServerConfig {
  model?: string;
  effort?: string;
  voiceModel?: string;
  voice?: string;
  workspace: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  port: number;
  codex: string;
  debug: boolean;
}

/** Option values from a single source (CLI or YAML), keyed by flag name. */
export interface ConfigValues {
  model?: string;
  effort?: string;
  "voice-model"?: string;
  voice?: string;
  workspace?: string;
  sandbox?: string;
  "approval-policy"?: string;
  port?: string | number;
  codex?: string;
}

export const CONFIG_KEYS = [
  "model",
  "effort",
  "voice-model",
  "voice",
  "workspace",
  "sandbox",
  "approval-policy",
  "port",
  "codex",
] as const;

export type Environ = Record<string, string | undefined>;

export class ConfigError extends Error {}

export function stateDirectory(env: Environ, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "agentvoicenext");
}

export function defaultConfigPath(env: Environ, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "agentvoicenext", "server.yaml");
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function parseYamlConfig(text: string, source: string): ConfigValues {
  let document: unknown;
  try {
    document = Bun.YAML.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${source}: not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document === null || document === undefined) return {};
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new ConfigError(`${source}: expected a mapping of options`);
  }
  const values: ConfigValues = {};
  for (const [key, raw] of Object.entries(document)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${source}: unknown option "${key}"`);
    }
    if (key === "port") {
      if (typeof raw !== "number" && typeof raw !== "string") {
        throw new ConfigError(`${source}: "port" must be a number`);
      }
      values.port = raw;
    } else {
      if (typeof raw !== "string") {
        throw new ConfigError(`${source}: "${key}" must be a string`);
      }
      (values as Record<string, string>)[key] = raw;
    }
  }
  return values;
}

export async function loadConfigFile(
  path: string,
  explicit: boolean,
): Promise<ConfigValues> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (explicit) throw new ConfigError(`config file not found: ${path}`);
    return {};
  }
  return parseYamlConfig(await file.text(), path);
}

export function resolveConfig(
  cli: ConfigValues,
  file: ConfigValues,
  env: Environ,
  home: string,
  debug = false,
): ServerConfig {
  const pick = <K extends keyof ConfigValues>(key: K): ConfigValues[K] =>
    cli[key] ?? file[key];

  const sandbox = pick("sandbox") ?? "danger-full-access";
  if (!(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
    throw new ConfigError(
      `sandbox must be one of ${SANDBOX_MODES.join(", ")}; got "${sandbox}"`,
    );
  }
  const approvalPolicy = pick("approval-policy") ?? "never";
  if (!(APPROVAL_POLICIES as readonly string[]).includes(approvalPolicy)) {
    throw new ConfigError(
      `approval-policy must be one of ${APPROVAL_POLICIES.join(", ")}; got "${approvalPolicy}"`,
    );
  }
  const portRaw = pick("port") ?? 7890;
  const port =
    typeof portRaw === "number" ? portRaw : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `port must be an integer between 1 and 65535; got "${portRaw}"`,
    );
  }
  const workspace = resolve(
    expandTilde(
      pick("workspace") ?? join(stateDirectory(env, home), "workspace"),
      home,
    ),
  );
  const codex = expandTilde(pick("codex") ?? env["CODEX_PATH"] ?? "codex", home);

  return {
    model: pick("model"),
    effort: pick("effort"),
    voiceModel: pick("voice-model"),
    voice: pick("voice"),
    workspace,
    sandbox: sandbox as SandboxMode,
    approvalPolicy: approvalPolicy as ApprovalPolicy,
    port,
    codex,
    debug,
  };
}
