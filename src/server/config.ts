/**
 * Server configuration: CLI flags over `server.yaml` over built-in defaults.
 * Options left unset are not sent to codex at all, so codex's own
 * configuration (`~/.codex/config.toml`) applies.
 *
 * Values are grouped by which agent they prime — `orchestrator` and `voice` —
 * not by which RPC carries them: the realtime session-boundary instructions
 * ride on `thread/realtime/start` but are developer messages to the
 * orchestrator agent, so they live on its side.
 *
 * Prose is never named here. Prompt files are discovered by convention next to
 * the config file; see PROMPT_FILES.
 */
import { dirname, join, resolve } from "node:path";
import { defaultConfigPath, type Environ, expandTilde, stateDirectory } from "../paths.ts";

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;
export const APPROVALS_REVIEWERS = ["user", "auto_review", "guardian_subagent"] as const;
export const PERSONALITIES = ["none", "friendly", "pragmatic"] as const;
export const HISTORY_MODES = ["legacy", "paginated"] as const;
export const REALTIME_VERSIONS = ["v1", "v2", "v3"] as const;
export const HANDOFF_MODES = ["thinking", "commentary", "bemTags"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];
export type ApprovalsReviewer = (typeof APPROVALS_REVIEWERS)[number];
export type Personality = (typeof PERSONALITIES)[number];
export type HistoryMode = (typeof HISTORY_MODES)[number];
export type RealtimeVersion = (typeof REALTIME_VERSIONS)[number];
export type HandoffMode = (typeof HANDOFF_MODES)[number];

/**
 * agentvoice pins realtime v3 rather than deferring to codex: initial items
 * are v3-only, and the verified session semantics in AGENTS.md are v3's.
 */
export const DEFAULT_REALTIME_VERSION: RealtimeVersion = "v3";

// ---------------------------------------------------------------------------
// Resolved configuration
// ---------------------------------------------------------------------------

/** Primes the orchestrator agent: the codex thread that does the actual work. */
export interface OrchestratorConfig {
  workspace: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  /** Declare the worker-dispatch tools on the orchestrator's thread. */
  dispatch?: boolean;
  /** Push `<worker_report>` turns at the orchestrator when workers finish. */
  dispatchReports?: boolean;
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
  version: RealtimeVersion;
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
  port: number;
  codex: string;
  debug: boolean;
  /** Directory prompt files are discovered in. */
  configDir: string;
  orchestrator: OrchestratorConfig;
  voice: VoiceConfig;
}

// ---------------------------------------------------------------------------
// Parsed option values (one source: CLI or YAML), keyed by config key
// ---------------------------------------------------------------------------

export interface OrchestratorValues {
  workspace?: string;
  dispatch?: boolean;
  "dispatch-reports"?: boolean;
  model?: string;
  effort?: string;
  personality?: Personality;
  sandbox?: SandboxMode;
  "approval-policy"?: ApprovalPolicy;
  "approvals-reviewer"?: ApprovalsReviewer;
  permissions?: string;
  "model-provider"?: string;
  "service-tier"?: string;
  ephemeral?: boolean;
  "history-mode"?: HistoryMode;
  "runtime-workspace-roots"?: string[];
  config?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface VoiceValues {
  model?: string;
  name?: string;
  version?: RealtimeVersion;
  "include-startup-context"?: boolean;
  "delegation-ack-filler"?: boolean;
  "codex-response-handoff-mode"?: HandoffMode;
  "codex-responses-as-items"?: boolean;
  "codex-response-item-prefix"?: string;
  "codex-response-handoff-channel-prefixes"?: Record<string, string[]>;
  "flush-transcript-tail-on-session-end"?: boolean;
  "client-managed-handoffs"?: boolean;
  extra?: Record<string, unknown>;
}

export interface ConfigValues {
  port?: string | number;
  codex?: string;
  orchestrator?: OrchestratorValues;
  voice?: VoiceValues;
}

export const SERVER_KEYS = ["port", "codex", "orchestrator", "voice"] as const;

export const ORCHESTRATOR_KEYS = [
  "workspace",
  "dispatch",
  "dispatch-reports",
  "model",
  "effort",
  "personality",
  "sandbox",
  "approval-policy",
  "approvals-reviewer",
  "permissions",
  "model-provider",
  "service-tier",
  "ephemeral",
  "history-mode",
  "runtime-workspace-roots",
  "config",
  "extra",
] as const;

export const VOICE_KEYS = [
  "model",
  "name",
  "version",
  "include-startup-context",
  "delegation-ack-filler",
  "codex-response-handoff-mode",
  "codex-responses-as-items",
  "codex-response-item-prefix",
  "codex-response-handoff-channel-prefixes",
  "flush-transcript-tail-on-session-end",
  "client-managed-handoffs",
  "extra",
] as const;

/** Flat keys from the pre-nesting layout, mapped to where they moved. */
export const MOVED_KEYS: Readonly<Record<string, string>> = {
  model: "orchestrator.model",
  effort: "orchestrator.effort",
  workspace: "orchestrator.workspace",
  sandbox: "orchestrator.sandbox",
  "approval-policy": "orchestrator.approval-policy",
  "voice-model": "voice.model",
};

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// Prompt files — discovered by convention, never named in the config
// ---------------------------------------------------------------------------

/**
 * Conventional filenames, resolved in the config file's directory. Each maps to
 * exactly one wire field. Absence means the field is not sent at all; an empty
 * file means the field is sent empty, which is how a built-in prompt is
 * stripped rather than replaced.
 */
export const PROMPT_FILES = {
  voicePrompt: "VOICE.md",
  voiceSeedDeveloper: "VOICE_SEED_DEVELOPER.md",
  voiceSeedUser: "VOICE_SEED_USER.md",
  voiceSeedAssistant: "VOICE_SEED_ASSISTANT.md",
  orchestratorDeveloperInstructions: "ORCHESTRATOR.md",
  orchestratorBaseInstructions: "ORCHESTRATOR_BASE.md",
  orchestratorSessionStart: "ORCHESTRATOR_SESSION_START.md",
  orchestratorSessionEnd: "ORCHESTRATOR_SESSION_END.md",
} as const;

export type PromptName = keyof typeof PROMPT_FILES;
export type Prompts = Partial<Record<PromptName, string>>;

/**
 * Seed items become `initialItems` in this fixed order. A flat directory cannot
 * express interleaving or repeats; `voice.extra.initialItems` covers that.
 */
export const VOICE_SEEDS: ReadonlyArray<readonly [PromptName, "developer" | "user" | "assistant"]> =
  [
    ["voiceSeedDeveloper", "developer"],
    ["voiceSeedUser", "user"],
    ["voiceSeedAssistant", "assistant"],
  ];

export async function readPrompts(directory: string): Promise<Prompts> {
  const prompts: Prompts = {};
  for (const [name, filename] of Object.entries(PROMPT_FILES) as [PromptName, string][]) {
    const file = Bun.file(join(directory, filename));
    if (await file.exists()) prompts[name] = await file.text();
  }
  return prompts;
}

/** Filenames of the prompts actually found, in PROMPT_FILES order. */
export function promptFilenames(prompts: Prompts): string[] {
  return (Object.entries(PROMPT_FILES) as [PromptName, string][])
    .filter(([name]) => prompts[name] !== undefined)
    .map(([, filename]) => filename);
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

function asBoolean(source: string, path: string, raw: unknown): boolean {
  if (typeof raw !== "boolean") fail(source, `"${path}" must be true or false`);
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

function asStringArray(source: string, path: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) fail(source, `"${path}" must be a list of strings`);
  return raw.map((entry, index) => asString(source, `${path}[${index}]`, entry));
}

function asMapping(source: string, path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(source, `"${path}" must be a mapping`);
  }
  return raw as Record<string, unknown>;
}

function asStringArrayMapping(
  source: string,
  path: string,
  raw: unknown,
): Record<string, string[]> {
  const mapping = asMapping(source, path, raw);
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(mapping)) {
    result[key] = asStringArray(source, `${path}.${key}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseOrchestrator(source: string, raw: unknown): OrchestratorValues {
  const mapping = asMapping(source, "orchestrator", raw);
  const values: OrchestratorValues = {};
  for (const [key, value] of Object.entries(mapping)) {
    const path = `orchestrator.${key}`;
    switch (key) {
      case "workspace":
      case "model":
      case "effort":
      case "permissions":
      case "model-provider":
      case "service-tier":
        (values as Record<string, unknown>)[key] = asString(source, path, value);
        break;
      case "personality":
        values.personality = asEnum(source, path, value, PERSONALITIES);
        break;
      case "sandbox":
        values.sandbox = asEnum(source, path, value, SANDBOX_MODES);
        break;
      case "approval-policy":
        values["approval-policy"] = asEnum(source, path, value, APPROVAL_POLICIES);
        break;
      case "approvals-reviewer":
        values["approvals-reviewer"] = asEnum(source, path, value, APPROVALS_REVIEWERS);
        break;
      case "history-mode":
        values["history-mode"] = asEnum(source, path, value, HISTORY_MODES);
        break;
      case "ephemeral":
        values.ephemeral = asBoolean(source, path, value);
        break;
      case "dispatch":
        values.dispatch = asBoolean(source, path, value);
        break;
      case "dispatch-reports":
        values["dispatch-reports"] = asBoolean(source, path, value);
        break;
      case "runtime-workspace-roots":
        values["runtime-workspace-roots"] = asStringArray(source, path, value);
        break;
      case "config":
      case "extra":
        values[key] = asMapping(source, path, value);
        break;
      default:
        fail(source, unknownKeyMessage(path, key, ORCHESTRATOR_KEYS));
    }
  }
  return values;
}

function parseVoice(source: string, raw: unknown): VoiceValues {
  if (typeof raw === "string") {
    fail(source, `"voice" is now a mapping; the voice name moved to "voice.name"`);
  }
  const mapping = asMapping(source, "voice", raw);
  const values: VoiceValues = {};
  for (const [key, value] of Object.entries(mapping)) {
    const path = `voice.${key}`;
    switch (key) {
      case "model":
      case "name":
      case "codex-response-item-prefix":
        (values as Record<string, unknown>)[key] = asString(source, path, value);
        break;
      case "version":
        values.version = asEnum(source, path, value, REALTIME_VERSIONS);
        break;
      case "codex-response-handoff-mode":
        values["codex-response-handoff-mode"] = asEnum(source, path, value, HANDOFF_MODES);
        break;
      case "include-startup-context":
      case "delegation-ack-filler":
      case "codex-responses-as-items":
      case "flush-transcript-tail-on-session-end":
      case "client-managed-handoffs":
        (values as Record<string, unknown>)[key] = asBoolean(source, path, value);
        break;
      case "codex-response-handoff-channel-prefixes":
        values["codex-response-handoff-channel-prefixes"] = asStringArrayMapping(
          source,
          path,
          value,
        );
        break;
      case "extra":
        values.extra = asMapping(source, path, value);
        break;
      default:
        fail(source, unknownKeyMessage(path, key, VOICE_KEYS));
    }
  }
  return values;
}

function unknownKeyMessage(path: string, key: string, known: readonly string[]): string {
  const moved = MOVED_KEYS[key];
  if (moved) return `unknown option "${path}" — did you mean "${moved}"?`;
  return `unknown option "${path}"; known keys: ${known.join(", ")}`;
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
    const moved = MOVED_KEYS[key];
    if (moved) {
      fail(source, `"${key}" moved to "${moved}"; see server.yaml.example`);
    }
    switch (key) {
      case "port":
        if (typeof raw !== "number" && typeof raw !== "string") {
          fail(source, `"port" must be a number`);
        }
        values.port = raw;
        break;
      case "codex":
        values.codex = asString(source, "codex", raw);
        break;
      case "orchestrator":
        values.orchestrator = parseOrchestrator(source, raw);
        break;
      case "voice":
        values.voice = parseVoice(source, raw);
        break;
      default:
        fail(source, `unknown option "${key}"; known keys: ${SERVER_KEYS.join(", ")}`);
    }
  }
  return values;
}

export async function loadConfigFile(path: string, explicit: boolean): Promise<ConfigValues> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (explicit) throw new ConfigError(`config file not found: ${path}`);
    return {};
  }
  return parseYamlConfig(await file.text(), path);
}

/**
 * CLI flags keep the flat names people type; nesting belongs in the file, not
 * in argv. Validation runs through the same helpers so a bad `--sandbox` fails
 * exactly like a bad `orchestrator.sandbox`.
 */
export function cliToConfigValues(values: Record<string, string>): ConfigValues {
  const source = "command line";
  const config: ConfigValues = {};
  const orchestrator: OrchestratorValues = {};
  const voice: VoiceValues = {};

  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case "port":
        config.port = value;
        break;
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
  debug?: boolean;
  /** Where prompt files are discovered; defaults to the default config dir. */
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

  const portRaw = pickTop("port") ?? 7890;
  const port = typeof portRaw === "number" ? portRaw : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`port must be an integer between 1 and 65535; got "${portRaw}"`);
  }

  const permissions = pickOrchestrator("permissions");
  const explicitSandbox = pickOrchestrator("sandbox");
  if (permissions !== undefined && explicitSandbox !== undefined) {
    throw new ConfigError(
      `orchestrator.permissions cannot be combined with orchestrator.sandbox; set only one`,
    );
  }

  const dispatch = pickOrchestrator("dispatch");
  const dispatchReports = pickOrchestrator("dispatch-reports");
  if (dispatchReports === true && dispatch !== true) {
    throw new ConfigError(
      `orchestrator.dispatch-reports requires orchestrator.dispatch: true — there are no workers to report without the dispatch tools`,
    );
  }

  const workspace = resolve(
    expandTilde(
      pickOrchestrator("workspace") ?? join(stateDirectory(env, home), "workspace"),
      home,
    ),
  );
  const roots = pickOrchestrator("runtime-workspace-roots");

  const orchestrator: OrchestratorConfig = {
    workspace,
    sandbox: explicitSandbox ?? "danger-full-access",
    approvalPolicy: pickOrchestrator("approval-policy") ?? "never",
    dispatch,
    dispatchReports,
    model: pickOrchestrator("model"),
    effort: pickOrchestrator("effort"),
    personality: pickOrchestrator("personality"),
    approvalsReviewer: pickOrchestrator("approvals-reviewer"),
    permissions,
    modelProvider: pickOrchestrator("model-provider"),
    serviceTier: pickOrchestrator("service-tier"),
    ephemeral: pickOrchestrator("ephemeral"),
    historyMode: pickOrchestrator("history-mode"),
    runtimeWorkspaceRoots: roots?.map((root) => resolve(expandTilde(root, home))),
    config: pickOrchestrator("config"),
    extra: pickOrchestrator("extra"),
  };

  const voice: VoiceConfig = {
    version: pickVoice("version") ?? DEFAULT_REALTIME_VERSION,
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
    port,
    codex: expandTilde(pickTop("codex") ?? env["CODEX_PATH"] ?? "codex", home),
    debug: options.debug ?? false,
    configDir: options.configDir ?? dirname(defaultConfigPath(env, home)),
    orchestrator,
    voice,
  };
}
