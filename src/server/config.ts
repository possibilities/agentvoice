/**
 * Server configuration: CLI flags over `server.json` over built-in defaults.
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
 * Prose is never named here. Prompt files are discovered by convention next to
 * the config file; see PROMPT_FILES.
 */
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { defaultConfigPath, type Environ, expandTilde, stateDirectory } from "../paths.ts";
import {
  ACCOUNTS_KEYS,
  type AccountsValues,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalsReviewer,
  type ConfigValues,
  configValuesSchema,
  DEFAULT_REALTIME_VERSION,
  DEFAULT_SWITCH_THRESHOLD,
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

export type {
  AccountsValues,
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
  ACCOUNTS_KEYS,
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  DEFAULT_REALTIME_VERSION,
  DEFAULT_SWITCH_THRESHOLD,
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

/** Opt-in multi-account balancing over account profiles. */
export interface AccountsConfig {
  /** Select the spawn account via the balancer; off means the canonical home. */
  balance: boolean;
  /** Utilization percent at which an idle child rotates to a better account. */
  switchThreshold: number;
}

export interface ServerConfig {
  port: number;
  codex: string;
  debug: boolean;
  /** Directory prompt files are discovered in. */
  configDir: string;
  accounts: AccountsConfig;
  orchestrator: OrchestratorConfig;
  voice: VoiceConfig;
}

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

/** The four strict objects, by dotted path, for unknown-key messages. */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  accounts: ACCOUNTS_KEYS,
  orchestrator: ORCHESTRATOR_KEYS,
  voice: VOICE_KEYS,
};

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

  // Reserved for editor tooling; carries no configuration, whatever its value.
  const { $schema: _schema, ...options } = document as Record<string, unknown>;
  const parsed = configValuesSchema.safeParse(options);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(source, issue !== undefined ? issueMessage(issue) : parsed.error.message);
  }
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
  const pickAccounts = <K extends keyof AccountsValues>(key: K): AccountsValues[K] =>
    cli.accounts?.[key] ?? file.accounts?.[key];
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
    accounts: {
      balance: pickAccounts("balance") ?? false,
      switchThreshold: pickAccounts("switch-threshold") ?? DEFAULT_SWITCH_THRESHOLD,
    },
    orchestrator,
    voice,
  };
}
