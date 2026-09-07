/**
 * Named application settings: CLI flags over `server.json` over built-in defaults.
 * Raw native fields merge later in params.ts and can override named CLI settings.
 * Options left unset are not sent to codex at all, so codex's own
 * configuration (`~/.codex/config.toml`) applies.
 *
 * Values are grouped by which agent they prime — `orchestrator` and `voice` —
 * not by which RPC carries them: the realtime session-boundary instructions
 * ride on `thread/realtime/start` but are developer messages to the
 * orchestrator agent, so they live on its side.
 *
 * The file surface itself — keys, types, enums, descriptions — is the zod
 * schema in `config-schema.ts`, which also generates `server.schema.json`.
 * This module owns everything around it: file discovery, CLI mapping,
 * precedence, and resolution.
 *
 * Prompt overrides are convention-named files beside the selected config:
 * each filename maps to exactly one native Codex control, presence loads it,
 * absence sends nothing. Retired filenames only warn and are never read.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { defaultConfigPath, type Environ, expandTilde } from "../paths.ts";
import { validateCodexConfig } from "./codex-config.ts";
import { ConfigError } from "./config-error.ts";
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalsReviewer,
  type ConfigValues,
  configValuesSchema,
  type HandoffMode,
  type HistoryMode,
  ORCHESTRATOR_KEYS,
  type OrchestratorValues,
  type Personality,
  type RealtimeVersion,
  SANDBOX_MODES,
  type SandboxMode,
  SERVER_KEYS,
  VOICE_KEYS,
  type VoiceValues,
} from "./config-schema.ts";
import { ROLE_PROMPT_FILES, resolveRolePath } from "./role.ts";

export type {
  ApprovalPolicy,
  ApprovalsReviewer,
  ConfigValues,
  HandoffMode,
  HistoryMode,
  OrchestratorValues,
  Personality,
  RealtimeVersion,
  SandboxMode,
  VoiceValues,
} from "./config-schema.ts";
export {
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  HANDOFF_MODES,
  HISTORY_MODES,
  ORCHESTRATOR_KEYS,
  PERSONALITIES,
  REALTIME_VERSIONS,
  SANDBOX_MODES,
  SERVER_KEYS,
  VOICE_KEYS,
} from "./config-schema.ts";

// ---------------------------------------------------------------------------
// Resolved configuration
// ---------------------------------------------------------------------------

/** Primes the orchestrator agent: the codex thread that does the actual work. */
export interface OrchestratorConfig {
  workspace: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  model?: string;
  effort?: string;
  personality?: Personality;
  approvalsReviewer?: ApprovalsReviewer;
  permissions?: string;
  modelProvider?: string;
  serviceTier?: string;
  ephemeral?: boolean;
  historyMode?: HistoryMode;
  runtimeWorkspaceRoots?: string[];
  /** Raw `~/.codex/config.toml` overrides for this thread. */
  config?: Record<string, unknown>;
  /** Raw `thread/start` passthrough, merged last. */
  extra?: Record<string, unknown>;
}

/** Primes the voice agent: the realtime speech model the user talks to. */
export interface VoiceConfig {
  version?: RealtimeVersion;
  model?: string;
  name?: string;
  includeStartupContext?: boolean;
  delegationAckFiller?: boolean;
  codexResponseHandoffMode?: HandoffMode;
  codexResponsesAsItems?: boolean;
  codexResponseItemPrefix?: string;
  codexResponseHandoffChannelPrefixes?: Record<string, string[]>;
  flushTranscriptTailOnSessionEnd?: boolean;
  clientManagedHandoffs?: boolean;
  /** Raw `thread/realtime/start` passthrough, merged last. */
  extra?: Record<string, unknown>;
}

export interface ServerConfig {
  /** Launch-only permission opt-in; native managed requirements remain authoritative. */
  allowFullAccess?: boolean;
  codex: string;
  /** Ordered native startup -c arguments; never shell-evaluated or hot-reloaded. */
  codexConfig?: string[];
  debug: boolean;
  /** Directory scanned for convention-named prompt files and legacy warnings. */
  configDir: string;
  /** Absolute role directory; replaces configDir as the prompt source and adds skills/MCPs. */
  role?: string;
  orchestrator: OrchestratorConfig;
  voice: VoiceConfig;
}

export { ConfigError } from "./config-error.ts";

// ---------------------------------------------------------------------------
// Convention prompt files — one native control per filename
// ---------------------------------------------------------------------------

/**
 * Filenames looked up in the selected config directory, or in the role
 * directory when a role is active. Each is one native Codex control; nothing
 * here is an AgentVoice-shaped overlay:
 * - VOICE_AGENT_SYSTEM_PROMPT replaces the realtime `prompt`.
 * - VOICE_AGENT_APPEND_SYSTEM_PROMPT rides Codex's startup-context slot, which
 *   native code renders after the built-in prompt (see params.ts).
 * - VOICE_ORCHESTRATOR_SYSTEM_PROMPT replaces thread `baseInstructions`.
 * - VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT is thread `developerInstructions`,
 *   Codex's own developer message after the base prompt.
 * - The SESSION files replace the realtime start/end instructions the
 *   orchestrator receives when a voice session opens or closes.
 * In a role, SYSTEM_PROMPT.md / APPEND_SYSTEM_PROMPT.md (role.ts) are the
 * general orchestrator files every harness receives; the VOICE_ORCHESTRATOR
 * pair, when present, stands in for them here, same kind for same kind.
 */
export const PROMPT_FILES = {
  voicePrompt: "VOICE_AGENT_SYSTEM_PROMPT.md",
  voiceAppend: "VOICE_AGENT_APPEND_SYSTEM_PROMPT.md",
  orchestratorBaseInstructions: "VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md",
  orchestratorDeveloperInstructions: "VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md",
  orchestratorSessionStart: "VOICE_ORCHESTRATOR_SESSION_START.md",
  orchestratorSessionEnd: "VOICE_ORCHESTRATOR_SESSION_END.md",
} as const;

export type PromptName = keyof typeof PROMPT_FILES;
export type Prompts = Partial<Record<PromptName, string>>;

/**
 * Codex renders this config value after the realtime prompt (`prompt`, blank
 * line, context) whenever includeStartupContext is true, replacing its
 * synthesized Recent Work snapshot. That is the only native path that appends
 * text to the built-in voice prompt, so VOICE_AGENT_APPEND_SYSTEM_PROMPT rides
 * it (params.ts). The slot has one owner: explicit startup-context settings,
 * including startup -c entries, conflict with the file.
 */
export const STARTUP_CONTEXT_KEY = "experimental_realtime_ws_startup_context";

/** Override and append for the same agent are one choice, not two layers. */
export const EXCLUSIVE_PROMPT_PAIRS: ReadonlyArray<readonly [PromptName, PromptName]> = [
  ["voicePrompt", "voiceAppend"],
  ["orchestratorBaseInstructions", "orchestratorDeveloperInstructions"],
];

/**
 * Retired filenames are retained solely for migration warnings. Their presence
 * never causes their contents to be read or injected.
 */
export const LEGACY_PROMPT_FILES = [
  "VOICE.md",
  "VOICE_SEED_DEVELOPER.md",
  "VOICE_SEED_USER.md",
  "VOICE_SEED_ASSISTANT.md",
  "ORCHESTRATOR.md",
  "ORCHESTRATOR_BASE.md",
  "ORCHESTRATOR_SESSION_START.md",
  "ORCHESTRATOR_SESSION_END.md",
] as const;

export interface LoadedPrompts {
  prompts: Prompts;
  /** Files that loaded, in stable role order, for the ready report. */
  paths: string[];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Whether a name exists in the directory at all (a broken link counts). */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new ConfigError(`cannot read ${path}: ${String(error)}`);
  }
}

/**
 * A name that exists must load: a broken link, directory or unreadable file
 * fails before Codex starts rather than silently sending nothing.
 */
async function readPromptFile(path: string, filename: string): Promise<string | undefined> {
  if (!(await present(path))) return undefined;
  try {
    if (!(await stat(path)).isFile()) throw new Error("expected a regular file");
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`${filename}: cannot read ${path}: ${String(error)}`);
  }
}

/**
 * Reads the six convention files from `dir` plus, when `general` is set, the
 * role's SYSTEM_PROMPT / APPEND_SYSTEM_PROMPT. Returns the effective prompts,
 * the files they came from, and every prompt file seen (for conflict messages).
 */
async function readPromptDirectory(
  dir: string,
  general: boolean,
): Promise<LoadedPrompts & { seen: string[] }> {
  const prompts: Prompts = {};
  const source: Partial<Record<PromptName, string>> = {};
  const seen: string[] = [];
  if (general) {
    for (const [name, filename] of Object.entries(ROLE_PROMPT_FILES) as [PromptName, string][]) {
      const text = await readPromptFile(join(dir, filename), filename);
      if (text === undefined) continue;
      prompts[name] = text;
      source[name] = filename;
      seen.push(filename);
    }
  }
  for (const [name, filename] of Object.entries(PROMPT_FILES) as [PromptName, string][]) {
    const text = await readPromptFile(join(dir, filename), filename);
    if (text === undefined) continue;
    // The voice-specific variant stands in for the general file of the same kind.
    prompts[name] = text;
    source[name] = filename;
    seen.push(filename);
  }
  for (const [override, append] of EXCLUSIVE_PROMPT_PAIRS) {
    if (prompts[override] !== undefined && prompts[append] !== undefined) {
      const files = seen.filter((filename) =>
        [
          source[override],
          source[append],
          general ? ROLE_PROMPT_FILES[override as keyof typeof ROLE_PROMPT_FILES] : undefined,
          general ? ROLE_PROMPT_FILES[append as keyof typeof ROLE_PROMPT_FILES] : undefined,
        ].includes(filename),
      );
      throw new ConfigError(
        `${files.join(" and ")} cannot both be present in ${dir}: choose a replacement or an append for this agent`,
      );
    }
  }
  const paths = (Object.keys(PROMPT_FILES) as PromptName[]).flatMap((name) =>
    source[name] === undefined ? [] : [join(dir, source[name])],
  );
  return { prompts, paths, seen };
}

/**
 * Loads prompt overrides from the role directory when a role is active,
 * otherwise from the config directory. Legacy names in the config directory
 * only warn; so do convention files there that an active role is shadowing.
 */
export async function readPrompts(
  config: Pick<ServerConfig, "configDir" | "codexConfig" | "role">,
  warn: (message: string) => void = () => {},
): Promise<LoadedPrompts> {
  const loaded = await readPromptDirectory(
    config.role ?? config.configDir,
    config.role !== undefined,
  );
  if (config.role !== undefined) {
    for (const filename of Object.values(PROMPT_FILES)) {
      const path = join(config.configDir, filename);
      if (await present(path))
        warn(`Ignoring ${path}: role ${config.role} supplies the prompt files for this launch.`);
    }
  }
  if (
    loaded.prompts.voiceAppend !== undefined &&
    config.codexConfig?.some(
      (entry) => entry.slice(0, entry.indexOf("=")).trim() === STARTUP_CONTEXT_KEY,
    )
  )
    throw new ConfigError(
      `${PROMPT_FILES.voiceAppend} uses Codex's startup-context slot; remove the ${STARTUP_CONTEXT_KEY} codex-config entry or the file`,
    );
  for (const filename of LEGACY_PROMPT_FILES) {
    const path = join(config.configDir, filename);
    try {
      await lstat(path); // Includes broken links; never reads legacy contents.
      warn(
        `Ignoring legacy prompt file ${path}; rename it to a VOICE_AGENT_* or VOICE_ORCHESTRATOR_* convention file to use it. No contents were loaded.`,
      );
    } catch (error) {
      if (!isMissing(error))
        warn(
          `Could not check legacy prompt path ${path}; no contents were loaded: ${String(error)}`,
        );
    }
  }
  return { prompts: loaded.prompts, paths: loaded.paths };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function fail(source: string, message: string): never {
  throw new ConfigError(`${source}: ${message}`);
}

function asString(source: string, path: string, raw: unknown): string {
  if (typeof raw !== "string") fail(source, `"${path}" must be a string`);
  return raw;
}

function asEnum<T extends string>(
  source: string,
  path: string,
  raw: unknown,
  allowed: readonly T[],
): T {
  const value = asString(source, path, raw);
  if (!(allowed as readonly string[]).includes(value)) {
    fail(source, `"${path}" must be one of ${allowed.join(", ")}; got "${value}"`);
  }
  return value as T;
}

function unknownKeyMessage(path: string, known: readonly string[]): string {
  return `unknown option "${path}"; known keys: ${known.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Parsing — zod issues rendered as the loader's own error prose
// ---------------------------------------------------------------------------

/** The strict section objects, by dotted path, for unknown-key messages. */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  orchestrator: ORCHESTRATOR_KEYS,
  voice: VOICE_KEYS,
};

/**
 * zod's object parser deliberately skips a literal own `__proto__` key as an
 * anti-pollution guard, so `strictObject` never reports it among its
 * `unrecognized_keys`. The strict levels rejected it before the schema port and
 * must keep rejecting it, so the raw `JSON.parse` output — where the key is
 * still an own data property — is scanned once the schema itself is satisfied.
 */
function rejectProtoKeys(source: string, document: Record<string, unknown>): void {
  if (Object.hasOwn(document, "__proto__")) {
    fail(source, unknownKeyMessage("__proto__", SERVER_KEYS));
  }
  for (const [section, known] of Object.entries(KNOWN_KEYS)) {
    const value = document[section];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (Object.hasOwn(value, "__proto__")) {
      fail(source, unknownKeyMessage(`${section}.__proto__`, known));
    }
  }
}

/** `["a", "b", 2]` → `a.b[2]` — the key path every config error must name. */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = "";
  for (const segment of path) {
    formatted +=
      typeof segment === "number"
        ? `[${segment}]`
        : formatted === ""
          ? String(segment)
          : `.${String(segment)}`;
  }
  return formatted;
}

function typeText(expected: string): string {
  switch (expected) {
    case "string":
      return "a string";
    case "boolean":
      return "true or false";
    case "int":
      return "an integer";
    case "number":
      return "a number";
    case "array":
      return "a list of strings";
    case "object":
    case "record":
      return "an object";
    default:
      return `of type ${expected}`;
  }
}

function issueMessage(issue: z.core.$ZodIssue): string {
  const path = formatIssuePath(issue.path);
  switch (issue.code) {
    case "unrecognized_keys": {
      const key = issue.keys[0] ?? "?";
      return unknownKeyMessage(
        path === "" ? key : `${path}.${key}`,
        KNOWN_KEYS[path] ?? SERVER_KEYS,
      );
    }
    case "invalid_type":
      return `"${path}" must be ${typeText(issue.expected)}`;
    case "invalid_value":
      return `"${path}" must be one of ${issue.values.join(", ")}`;
    case "too_small":
      return `"${path}" must be at least ${issue.minimum}`;
    case "too_big":
      return `"${path}" must be at most ${issue.maximum}`;
    case "invalid_union": {
      const expected: string[] = [];
      for (const branchIssue of issue.errors.flat()) {
        if (branchIssue.code === "invalid_type" && !expected.includes(branchIssue.expected)) {
          expected.push(branchIssue.expected);
        }
      }
      return expected.length > 0
        ? `"${path}" must be ${expected.map(typeText).join(" or ")}`
        : `"${path}" is invalid`;
    }
    default:
      return `"${path}": ${issue.message}`;
  }
}

export function parseJsonConfig(text: string, source: string): ConfigValues {
  if (text.trim().length === 0) return {};
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${source}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document === null || document === undefined) return {};
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new ConfigError(`${source}: expected an object of options`);
  }

  const raw = document as Record<string, unknown>;
  if (Object.hasOwn(raw, "accounts"))
    throw new ConfigError(
      `${source}: accounts configuration has been retired; remove the entire accounts section, including balance: false. AgentVoice inherits native Codex authentication and CODEX_HOME. Existing profiles and credentials are untouched; see README migration notes.`,
    );
  const orchestrator = raw["orchestrator"];
  if (orchestrator && typeof orchestrator === "object") {
    for (const key of ["dispatch", "dispatch-reports"]) {
      if (Object.hasOwn(orchestrator, key))
        throw new ConfigError(
          `${source}: orchestrator.${key} has been retired with AgentVoice's custom worker tools; remove this key. Native Codex tools and voice handoffs are unchanged.`,
        );
    }
  }
  const voice = raw["voice"];
  if (voice && typeof voice === "object") {
    for (const key of ["quiet-resume", "replay-spoken-history"]) {
      if (Object.hasOwn(voice, key))
        throw new ConfigError(
          `${source}: voice.${key} has been retired; remove this key. AgentVoice no longer injects speech history or its own reconnect instructions. Native working-thread continuation is unchanged.`,
        );
    }
  }
  if (Object.hasOwn(raw, "remote"))
    throw new ConfigError(
      `${source}: remote configuration has been retired; remove the remote section to use the foreground TUI`,
    );
  // Reserved for editor tooling; carries no configuration, whatever its value.
  const { $schema: _schema, ...options } = raw;
  const parsed = configValuesSchema.safeParse(options);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(source, issue !== undefined ? issueMessage(issue) : parsed.error.message);
  }
  rejectProtoKeys(source, raw);
  return parsed.data;
}

export async function loadConfigFile(path: string, explicit: boolean): Promise<ConfigValues> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (explicit) throw new ConfigError(`config file not found: ${path}`);
    return {};
  }
  return parseJsonConfig(await file.text(), path);
}

/**
 * CLI flags keep the flat names people type; nesting belongs in the file, not
 * in argv. Enum flags validate against the same allowed values as the file
 * schema, so a bad `--sandbox` fails exactly like a bad `orchestrator.sandbox`.
 */
export function cliToConfigValues(values: Record<string, string>): ConfigValues {
  const source = "command line";
  const config: ConfigValues = {};
  const orchestrator: OrchestratorValues = {};
  const voice: VoiceValues = {};

  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case "codex":
        config.codex = value;
        break;
      case "model":
      case "effort":
      case "workspace":
        orchestrator[key] = value;
        break;
      case "sandbox":
        orchestrator.sandbox = asEnum(source, "--sandbox", value, SANDBOX_MODES);
        break;
      case "approval-policy":
        orchestrator["approval-policy"] = asEnum(
          source,
          "--approval-policy",
          value,
          APPROVAL_POLICIES,
        );
        break;
      case "voice-model":
        voice.model = value;
        break;
      case "voice":
        voice.name = value;
        break;
      case "role":
        config.role = value;
        break;
      default:
        fail(source, `unhandled option "--${key}"`);
    }
  }

  if (Object.keys(orchestrator).length > 0) config.orchestrator = orchestrator;
  if (Object.keys(voice).length > 0) config.voice = voice;
  return config;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  allowFullAccess?: boolean;
  launchCwd?: string;
  /** Filesystem-selected generation supplied by launch preflight; resolution stays pure. */
  defaultWorkspace?: string;
  debug?: boolean;
  /** Directory scanned for convention prompt files; defaults to the default config directory. */
  configDir?: string;
}

export function resolveConfig(
  cli: ConfigValues,
  file: ConfigValues,
  env: Environ,
  home: string,
  options: ResolveOptions = {},
): ServerConfig {
  const pickTop = <K extends keyof ConfigValues>(key: K): ConfigValues[K] => cli[key] ?? file[key];
  const pickOrchestrator = <K extends keyof OrchestratorValues>(key: K): OrchestratorValues[K] =>
    cli.orchestrator?.[key] ?? file.orchestrator?.[key];
  const pickVoice = <K extends keyof VoiceValues>(key: K): VoiceValues[K] =>
    cli.voice?.[key] ?? file.voice?.[key];

  const codexConfig = [...(file["codex-config"] ?? []), ...(cli["codex-config"] ?? [])];
  try {
    validateCodexConfig(codexConfig);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  const configDir = resolve(
    options.launchCwd ?? process.cwd(),
    options.configDir ?? dirname(defaultConfigPath(env, home)),
  );
  const roleSpec = pickTop("role");
  const role =
    roleSpec === undefined
      ? undefined
      : resolveRolePath(roleSpec, env, home, options.launchCwd ?? process.cwd());
  const permissions = pickOrchestrator("permissions");
  const explicitSandbox = pickOrchestrator("sandbox");
  if (!options.allowFullAccess && permissions !== undefined && explicitSandbox !== undefined) {
    throw new ConfigError(
      `orchestrator.permissions cannot be combined with orchestrator.sandbox; set only one`,
    );
  }

  const launchCwd = options.launchCwd ?? process.cwd();
  const workspaceValue = pickOrchestrator("workspace") ?? options.defaultWorkspace ?? launchCwd;
  if (!workspaceValue.trim()) throw new ConfigError("workspace must be a non-empty directory");
  const workspace = resolve(launchCwd, expandTilde(workspaceValue, home));
  const extra = pickOrchestrator("extra");
  const rawCwd = extra?.["cwd"];
  if (
    rawCwd !== undefined &&
    (typeof rawCwd !== "string" || resolve(launchCwd, expandTilde(rawCwd, home)) !== workspace)
  ) {
    throw new ConfigError(
      "orchestrator.extra.cwd conflicts with the selected workspace; use --workspace",
    );
  }
  for (const key of ["threadId", "path", "history"]) {
    if (extra && Object.hasOwn(extra, key))
      throw new ConfigError(
        `orchestrator.extra.${key} cannot override conversation identity; use --resume`,
      );
  }
  const voiceExtra = pickVoice("extra");
  for (const key of ["threadId", "realtimeSessionId"]) {
    if (voiceExtra && Object.hasOwn(voiceExtra, key))
      throw new ConfigError(`voice.extra.${key} cannot override conversation identity`);
  }
  const roots = pickOrchestrator("runtime-workspace-roots");

  const orchestrator: OrchestratorConfig = {
    workspace,
    sandbox: explicitSandbox,
    approvalPolicy: pickOrchestrator("approval-policy"),
    model: pickOrchestrator("model"),
    effort: pickOrchestrator("effort"),
    personality: pickOrchestrator("personality"),
    approvalsReviewer: pickOrchestrator("approvals-reviewer"),
    permissions,
    modelProvider: pickOrchestrator("model-provider"),
    serviceTier: pickOrchestrator("service-tier"),
    ephemeral: pickOrchestrator("ephemeral"),
    historyMode: pickOrchestrator("history-mode"),
    runtimeWorkspaceRoots: roots?.map((root) => resolve(workspace, expandTilde(root, home))),
    config: pickOrchestrator("config"),
    extra: pickOrchestrator("extra"),
  };

  const voice: VoiceConfig = {
    version: pickVoice("version"),
    model: pickVoice("model"),
    name: pickVoice("name"),
    includeStartupContext: pickVoice("include-startup-context"),
    delegationAckFiller: pickVoice("delegation-ack-filler"),
    codexResponseHandoffMode: pickVoice("codex-response-handoff-mode"),
    codexResponsesAsItems: pickVoice("codex-responses-as-items"),
    codexResponseItemPrefix: pickVoice("codex-response-item-prefix"),
    codexResponseHandoffChannelPrefixes: pickVoice("codex-response-handoff-channel-prefixes"),
    flushTranscriptTailOnSessionEnd: pickVoice("flush-transcript-tail-on-session-end"),
    clientManagedHandoffs: pickVoice("client-managed-handoffs"),
    extra: pickVoice("extra"),
  };

  return {
    ...(options.allowFullAccess ? { allowFullAccess: true } : {}),
    codex: expandTilde(pickTop("codex") ?? env["CODEX_PATH"] ?? "codex", home),
    ...(codexConfig.length > 0 ? { codexConfig } : {}),
    debug: options.debug ?? false,
    configDir,
    ...(role === undefined ? {} : { role }),
    orchestrator,
    voice,
  };
}
