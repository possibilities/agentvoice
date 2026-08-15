/**
 * The `server.json` surface as a zod schema — the single source of truth:
 * `config.ts` validates file values with it at load, and
 * `scripts/generate-schema.ts` emits `server.schema.json` from it, so a config
 * key exists exactly when it is declared (and described) here.
 *
 * Contract:
 * - Every field is `.optional()` and none carries a zod `.default()`: an unset
 *   key must stay unset through parse so resolution can keep it unset and
 *   never send it to codex at all. The `default` entries in `.meta()` are
 *   schema documentation of resolution-time behavior, not parse-time values.
 * - The root, `accounts`, `orchestrator`, and `voice` reject unknown keys.
 *   `strictObject` alone does not finish that job: zod skips a literal own
 *   `__proto__` key, so `config.ts` scans the raw document for it separately.
 *   `orchestrator.config`, `orchestrator.extra`, and `voice.extra` are open
 *   passthroughs into the codex key space and must stay open.
 * - `$schema` appears only in the published-file schema; the loader tolerates
 *   and strips it before validation, whatever its value.
 */
import { z } from "zod";

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

export const DEFAULT_SWITCH_THRESHOLD = 95;

/** An object whose contents forward verbatim — never recursed or validated. */
const passthrough = (description: string) => z.looseObject({}).describe(description);

export const accountsValuesSchema = z
  .strictObject({
    balance: z
      .boolean()
      .meta({
        description:
          "Ask the balancer (`agentusage balance codex`, falling back to `codex-swap select`) which account to run on at every app-server child spawn. Needs profiles: `agentvoice accounts add <slug>` once per account — with codex-swap installed and none logged in, boot exits with the exact onboarding commands. Without the balancer CLIs, or on transient refusals, the server falls back to the canonical home loudly. Default: false (the canonical ~/.codex and whatever `codex login` put there).",
        default: false,
      })
      .optional(),
    "switch-threshold": z
      .int()
      .min(50)
      .max(100)
      .meta({
        description: "Utilization percent at which an idle child rotates to a better account.",
        default: DEFAULT_SWITCH_THRESHOLD,
      })
      .optional(),
  })
  .meta({
    description:
      "Opt-in multi-account balancing over account profiles: per-account CODEX_HOMEs under ~/.local/state/agentvoice/accounts/, each holding its own auth.json and private app-server control directory, with session/config state symlinked to the canonical ~/.codex so every account shares one session store (threads resume across accounts).",
  });

export const orchestratorValuesSchema = z
  .strictObject({
    workspace: z
      .string()
      .describe(
        "The agent's working directory (its cwd; an AGENTS.md there applies). Tilde-expanded. Default: ~/.local/state/agentvoice/workspace.",
      )
      .optional(),
    dispatch: z
      .boolean()
      .meta({
        description:
          "Declare three dynamic tools on the orchestrator's thread — dispatch_worker, check_workers, cancel_worker — so it can run asynchronous work as sibling worker threads. Workers inherit the execution posture (sandbox, approvals, model, config) but no prompt files and no dispatch tools. Pull-only by default: results are read with check_workers. Default: false.",
        default: false,
      })
      .optional(),
    "dispatch-reports": z
      .boolean()
      .meta({
        description:
          "Additionally push a <worker_report> turn at the orchestrator when a worker finishes — the evented mode a doctrine written for fire-and-forget expects. The tool descriptions promise whichever mode is on. Requires dispatch: true. Default: false.",
        default: false,
      })
      .optional(),
    model: z
      .string()
      .describe(
        "Orchestrator model id. Mind the auth class: codex-branded models (gpt-5.3-codex …) are rejected on ChatGPT-account auth. Default: codex config.",
      )
      .optional(),
    effort: z
      .string()
      .describe(
        "Reasoning effort (none…ultra); sugar for model_reasoning_effort. An entry in orchestrator.config beats this shorthand. Note: ultra additionally switches on codex's proactive multi-agent mode. Default: codex config.",
      )
      .optional(),
    personality: z
      .enum(PERSONALITIES)
      .describe(
        "Orchestrator personality. Silently disabled when ORCHESTRATOR_BASE.md replaces the system prompt (the server warns at boot). Default: codex config.",
      )
      .optional(),
    sandbox: z
      .enum(SANDBOX_MODES)
      .meta({
        description:
          "Execution sandbox for the orchestrator thread. NOT combinable with permissions — set one or the other.",
        default: "danger-full-access",
      })
      .optional(),
    "approval-policy": z
      .enum(APPROVAL_POLICIES)
      .meta({ description: "When codex escalates for approval.", default: "never" })
      .optional(),
    "approvals-reviewer": z
      .enum(APPROVALS_REVIEWERS)
      .describe(
        "Who reviews approval requests. auto_review gives escalations outside the sandbox an AI review (~3 s) instead of agentvoice's blanket fail-closed denial. Default: user.",
      )
      .optional(),
    permissions: z
      .string()
      .describe("Named permission profile. NOT combinable with sandbox — set one or the other.")
      .optional(),
    "model-provider": z.string().describe("Model provider id. Default: codex config.").optional(),
    "service-tier": z.string().describe("Service tier. Default: codex config.").optional(),
    ephemeral: z
      .boolean()
      .describe("Leave no persisted thread history. Default: false.")
      .optional(),
    "history-mode": z
      .enum(HISTORY_MODES)
      .describe("Thread history mode. Default: codex config.")
      .optional(),
    "runtime-workspace-roots": z
      .array(z.string())
      .describe("Replaces the thread's workspace roots. Entries are tilde-expanded.")
      .optional(),
    config: passthrough(
      "Raw ~/.codex/config.toml overrides, applied to this thread only. An entry here beats the effort shorthand above.",
    ).optional(),
    extra: passthrough(
      "Raw thread/start passthrough, merged last — anything the protocol accepts but this file does not name yet. Typos surface as RPC errors at boot, not as config errors.",
    ).optional(),
  })
  .meta({
    description: "Primes the orchestrator agent — the codex thread that does the actual work.",
    // Cross-key constraints, enforced at resolution (resolveConfig) where CLI
    // and file values have already merged; stated here so editors flag them.
    allOf: [
      {
        not: { required: ["permissions", "sandbox"] },
      },
      {
        if: {
          properties: { "dispatch-reports": { const: true } },
          required: ["dispatch-reports"],
        },
        // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword, not a thenable.
        then: {
          properties: { dispatch: { const: true } },
          required: ["dispatch"],
        },
      },
    ],
  });

export const voiceValuesSchema = z
  .strictObject({
    model: z
      .string()
      .describe("Realtime voice model id. Default: codex config / upstream.")
      .optional(),
    name: z
      .string()
      .describe(
        "Voice timbre. v3 timbres: arbor breeze cove ember juniper maple sol spruce vale (alloy ash ballad cedar coral echo marin sage shimmer verse are v2-only and REJECTED under v3). Default: upstream.",
      )
      .optional(),
    version: z
      .enum(REALTIME_VERSIONS)
      .meta({
        description:
          "Realtime protocol version. agentvoice defaults to v3 rather than deferring to codex config: seed items are v3-only, and the verified session semantics are v3's.",
        default: DEFAULT_REALTIME_VERSION,
      })
      .optional(),
    "include-startup-context": z
      .boolean()
      .describe(
        "Append a synthesized <startup_context> to the voice agent's instructions: the current thread, recent work across your other codex threads, and a depth-2 workspace tree. Worth false for an empty workspace. Default: upstream behavior.",
      )
      .optional(),
    "delegation-ack-filler": z
      .boolean()
      .describe(
        "Let the voice agent emit a filler acknowledgement while the orchestrator works. Unset keeps the Realtime API's own behavior.",
      )
      .optional(),
    "codex-response-handoff-mode": z
      .enum(HANDOFF_MODES)
      .describe("How orchestrator output is handed to the voice agent.")
      .optional(),
    "codex-responses-as-items": z
      .boolean()
      .describe("Deliver orchestrator output as conversation items. Default: false.")
      .optional(),
    "codex-response-item-prefix": z
      .string()
      .describe("Prefix for those conversation items.")
      .optional(),
    "codex-response-handoff-channel-prefixes": z
      .record(z.string(), z.array(z.string()))
      .describe(
        'Rename the bracketed channel markers per channel, e.g. {"final": ["[RESULT] "], "analysis": ["[THINKING] "], "commentary": ["[NOTE] "]}.',
      )
      .optional(),
    "flush-transcript-tail-on-session-end": z
      .boolean()
      .meta({
        description:
          "Route any leftover transcript tail through the orchestrator when the session ends.",
        default: false,
      })
      .optional(),
    "client-managed-handoffs": z
      .boolean()
      .meta({
        description:
          "SHARP EDGE: true stops app-server from forwarding orchestrator output to the voice agent, expecting the client to append it explicitly. agentvoice never does, so true silently severs the two agents. Default: false.",
        default: false,
      })
      .optional(),
    extra: passthrough(
      "Raw thread/realtime/start passthrough, merged last. outputModality and transport are owned by the server and belong here if you ever need them.",
    ).optional(),
  })
  .meta({
    description: "Primes the voice agent — the realtime speech model the user talks to.",
  });

const serverShape = {
  codex: z
    .string()
    .describe(
      'The codex binary to spawn. Tilde-expanded. Default: $CODEX_PATH, else "codex" on PATH.',
    )
    .optional(),
  accounts: accountsValuesSchema.optional(),
  orchestrator: orchestratorValuesSchema.optional(),
  voice: voiceValuesSchema.optional(),
};

/** What the loader validates: `server.json` contents with `$schema` already stripped. */
export const configValuesSchema = z.strictObject(serverShape);

/**
 * What `server.schema.json` documents: the same surface plus the `$schema` key
 * a config file may carry for editor tooling.
 */
export const configFileSchema = z.strictObject({
  $schema: z.string().describe("Reserved for editor tooling; agentvoice ignores it.").optional(),
  ...serverShape,
});

export type AccountsValues = z.infer<typeof accountsValuesSchema>;
export type OrchestratorValues = z.infer<typeof orchestratorValuesSchema>;
export type VoiceValues = z.infer<typeof voiceValuesSchema>;
export type ConfigValues = z.infer<typeof configValuesSchema>;

export const SERVER_KEYS: ReadonlyArray<string> = Object.keys(serverShape);
export const ACCOUNTS_KEYS: ReadonlyArray<string> = Object.keys(accountsValuesSchema.shape);
export const ORCHESTRATOR_KEYS: ReadonlyArray<string> = Object.keys(orchestratorValuesSchema.shape);
export const VOICE_KEYS: ReadonlyArray<string> = Object.keys(voiceValuesSchema.shape);
