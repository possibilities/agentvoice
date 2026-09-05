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
 * Prompt files load only through explicit `prompt-files` references. Legacy
 * filenames are checked for migration warnings, never read implicitly.
 */
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { defaultConfigPath, type Environ, expandTilde } from "../paths.ts";
import { validateCodexConfig } from "./codex-config.ts";
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
  PROMPT_FILE_KEYS,
  type PromptFilesValues,
  type RealtimeVersion,
  SANDBOX_MODES,
  type SandboxMode,
  SERVER_KEYS,
  VOICE_KEYS,
  type VoiceValues,
} from "./config-schema.ts";
import { validateFullAccessParams } from "./full-access.ts";

export type {
  ApprovalPolicy,
  ApprovalsReviewer,
  ConfigValues,
  HandoffMode,
  HistoryMode,
  OrchestratorValues,
  Personality,
  PromptFilesValues,
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
  PROMPT_FILE_KEYS,
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
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
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
  quietResume?: boolean;
  replaySpokenHistory?: boolean;
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
  codex: string;
  /** Ordered native startup -c arguments; never shell-evaluated or hot-reloaded. */
  codexConfig?: string[];
  debug: boolean;
  /** Base for explicit relative prompt-file paths; legacy warnings only otherwise. */
  configDir: string;
  /** Explicit references resolved to absolute paths; omission stays unset. */
  promptFiles?: PromptFilesValues;
  orchestrator: OrchestratorConfig;
  voice: VoiceConfig;
}

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// Explicit prompt-file inputs and metadata-only legacy warnings
// ---------------------------------------------------------------------------

/**
 * Retired filenames are retained solely for migration warnings. Their presence
 * never causes their contents to be read or injected.
 */
export const LEGACY_PROMPT_FILES = {
  voicePrompt: "VOICE.md",
  voiceSeedDeveloper: "VOICE_SEED_DEVELOPER.md",
  voiceSeedUser: "VOICE_SEED_USER.md",
  voiceSeedAssistant: "VOICE_SEED_ASSISTANT.md",
  orchestratorDeveloperInstructions: "ORCHESTRATOR.md",
  orchestratorBaseInstructions: "ORCHESTRATOR_BASE.md",
  orchestratorSessionStart: "ORCHESTRATOR_SESSION_START.md",
  orchestratorSessionEnd: "ORCHESTRATOR_SESSION_END.md",
} as const;

export type PromptName = keyof typeof LEGACY_PROMPT_FILES;
export type Prompts = Partial<Record<PromptName, string>>;

export const PROMPT_FIELDS = {
  voice: "voicePrompt",
  orchestrator: "orchestratorDeveloperInstructions",
  "orchestrator-base": "orchestratorBaseInstructions",
  "orchestrator-session-start": "orchestratorSessionStart",
  "orchestrator-session-end": "orchestratorSessionEnd",
  "voice-seed-developer": "voiceSeedDeveloper",
  "voice-seed-user": "voiceSeedUser",
  "voice-seed-assistant": "voiceSeedAssistant",
} as const satisfies Record<keyof PromptFilesValues, PromptName>;

/**
 * Explicit seed files become `initialItems` in this fixed order. Interleaving
 * or repeated roles can be expressed directly through `voice.extra.initialItems`.
 */
export const VOICE_SEEDS: ReadonlyArray<readonly [PromptName, "developer" | "user" | "assistant"]> =
  [
    ["voiceSeedDeveloper", "developer"],
    ["voiceSeedUser", "user"],
    ["voiceSeedAssistant", "assistant"],
  ];

export async function readPrompts(
  config: Pick<ServerConfig, "configDir" | "promptFiles">,
  warn: (message: string) => void = () => {},
): Promise<Prompts> {
  const prompts: Prompts = {};
  const loadedPaths = new Set<string>();
  for (const [key, name] of Object.entries(PROMPT_FIELDS)) {
    const path = config.promptFiles?.[key as keyof PromptFilesValues];
    if (path === undefined) continue;
    try {
      if (!(await stat(path)).isFile()) throw new Error("expected a regular file");
      prompts[name] = await readFile(path, "utf8");
      loadedPaths.add(await realpath(path));
    } catch (error) {
      throw new ConfigError(`prompt-files.${key}: cannot read ${path}: ${String(error)}`);
    }
  }
  for (const filename of Object.values(LEGACY_PROMPT_FILES)) {
    const path = join(config.configDir, filename);
    try {
      await lstat(path); // Includes broken links; never reads unreferenced file contents.
      const target = await realpath(path).catch(() => path);
      if (loadedPaths.has(target)) continue;
      warn(
        `Ignoring legacy prompt file ${path}; filenames no longer activate prompts. Add an explicit prompt-files reference to use it. No contents were loaded.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(
          `Could not check legacy prompt path ${path}; no contents were loaded: ${String(error)}`,
        );
    }
  }
  return prompts;
}

/** Configured paths, in stable role order; call only after successful loading. */
export function promptPaths(config: Pick<ServerConfig, "promptFiles">): string[] {
  return Object.keys(PROMPT_FIELDS).flatMap((key) => {
    const path = config.promptFiles?.[key as keyof PromptFilesValues];
    return path === undefined ? [] : [path];
  });
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
  "prompt-files": PROMPT_FILE_KEYS,
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
  launchCwd?: string;
  debug?: boolean;
  /** Base for explicit prompt paths; defaults to the default config directory. */
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
  const promptFiles: PromptFilesValues = {};
  for (const key of Object.keys(PROMPT_FIELDS) as (keyof PromptFilesValues)[]) {
    const path = cli["prompt-files"]?.[key] ?? file["prompt-files"]?.[key];
    if (path === undefined) continue;
    if (!path.trim()) throw new ConfigError(`prompt-files.${key} must be a non-empty file path`);
    promptFiles[key] = resolve(configDir, expandTilde(path, home));
  }

  const permissions = pickOrchestrator("permissions");
  const explicitSandbox = pickOrchestrator("sandbox");
  if (permissions !== undefined && explicitSandbox !== undefined) {
    throw new ConfigError(
      `orchestrator.permissions cannot be combined with orchestrator.sandbox; set only one`,
    );
  }

  const launchCwd = options.launchCwd ?? process.cwd();
  const workspaceValue = pickOrchestrator("workspace") ?? launchCwd;
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
    sandbox: explicitSandbox ?? "danger-full-access",
    approvalPolicy: pickOrchestrator("approval-policy") ?? "never",
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
    quietResume: pickVoice("quiet-resume"),
    replaySpokenHistory: pickVoice("replay-spoken-history"),
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

  try {
    validateFullAccessParams(
      {
        sandbox: orchestrator.sandbox,
        permissions: orchestrator.permissions,
        approvalPolicy: orchestrator.approvalPolicy,
        config: orchestrator.config,
      },
      "orchestrator",
    );
    validateFullAccessParams(orchestrator.extra ?? {}, "orchestrator.extra");
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  return {
    codex: expandTilde(pickTop("codex") ?? env["CODEX_PATH"] ?? "codex", home),
    ...(codexConfig.length > 0 ? { codexConfig } : {}),
    debug: options.debug ?? false,
    configDir,
    ...(Object.keys(promptFiles).length > 0 ? { promptFiles } : {}),
    orchestrator,
    voice,
  };
}
