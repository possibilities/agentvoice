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
 * - The root, `orchestrator`, and `voice` reject unknown keys.
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

/** An object whose contents forward verbatim — never recursed or validated. */
const passthrough = (description: string) => z.looseObject({}).describe(description);

export const orchestratorValuesSchema = z
  .strictObject({
    workspace: z
      .string()
      .describe(
        "The conversation workspace: native session selection and the Codex thread use this root. Tilde-expanded; relative paths use the launch directory. Default: launch cwd. --workspace overrides this value.",
      )
      .optional(),
    model: z
      .string()
      .describe(
        "Working-agent model id passed to Codex. Availability depends on the native provider and authentication. Default: Codex configuration.",
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
        "Orchestrator personality. Silently disabled when ORCHESTRATOR_BASE.md replaces the system prompt (the app warns at boot). Default: codex config.",
      )
      .optional(),
    sandbox: z
      .enum(SANDBOX_MODES)
      .meta({
        description:
          "Full-access-only product policy: only danger-full-access is accepted at launch. Incompatible values error. NOT combinable with permissions.",
        default: "danger-full-access",
      })
      .optional(),
    "approval-policy": z
      .enum(APPROVAL_POLICIES)
      .meta({
        description:
          "Full-access-only product policy: only never is accepted at launch. No approval UI is provided.",
        default: "never",
      })
      .optional(),
    "approvals-reviewer": z
      .enum(APPROVALS_REVIEWERS)
      .describe(
        "Native reviewer passthrough; execution approvals are disabled by the mandatory never policy. This does not grant connector consent or answer questions. Default: native configuration.",
      )
      .optional(),
    permissions: z
      .string()
      .describe(
        "Only the built-in :danger-full-access profile is supported; other profiles error at launch. NOT combinable with sandbox.",
      )
      .optional(),
    "model-provider": z.string().describe("Model provider id. Default: codex config.").optional(),
    "service-tier": z
      .string()
      .describe(
        "Native service-tier passthrough. Default: codex config. Launch flags --fast/--no-fast take precedence (including over extra.serviceTier); --fast checks the native model catalog and enables the thread-local Fast gate.",
      )
      .optional(),
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
      .describe(
        "Replaces the thread's workspace roots. Entries are tilde-expanded; relative entries resolve inside the selected workspace.",
      )
      .optional(),
    config: passthrough(
      "Raw ~/.codex/config.toml overrides, applied to this thread only. Permission selectors must match danger-full-access / never. An entry here beats the effort shorthand above. experimental_realtime_ws_startup_context replaces Codex's generated voice startup snapshot when startup context is enabled; an empty string suppresses that snapshot without erasing thread history.",
    ).optional(),
    extra: passthrough(
      "Raw thread/start or thread/resume passthrough, merged last except workspace and AgentVoice source identity. Permission selectors must match danger-full-access / never. Conflicting cwd and threadId/path/history overrides are rejected. Upstream can silently ignore unknown or start-only fields on resume; consult its protocol.",
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
        "Voice timbre, validated against the effective native protocol. Current v1/v3 timbres: arbor breeze cove ember juniper maple sol spruce vale. Legacy v2 timbres are incompatible with WebRTC. Unset uses native transport-specific behavior; omitting version also ignores Codex's configured realtime voice on WebRTC (Codex 0.153.3). Explicit voice.name is still passed through.",
      )
      .optional(),
    version: z
      .enum(REALTIME_VERSIONS)
      .describe(
        "Optional native realtime protocol override. Unset omits version, preserving Codex's transport-specific default (WebRTC uses v1 in Codex 0.153.3, not the general realtime config). Set v3 explicitly to preserve AgentVoice's former protocol or use initial seed items. WebRTC rejects v2.",
      )
      .optional(),
    "include-startup-context": z
      .boolean()
      .describe(
        "Include Codex's startup snapshot in the voice instructions: current-thread history, recent work from other threads, and a bounded machine/workspace map. Omitted defers to Codex (currently on for our WebRTC transport). False skips both generated and overridden startup context; it does not erase the orchestrator's history or prevent later recall through delegation. When enabled, orchestrator.config.experimental_realtime_ws_startup_context replaces the snapshot, including an empty string to suppress it.",
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
      .describe(
        "Ask Codex to send leftover speech transcripts to the orchestrator when the voice session ends, potentially causing work after hangup. Independent of include-startup-context: this delivers transcript text, while that setting controls the next session's startup snapshot. Omitted defers to Codex (currently off). False does not suppress transcripts sent during ordinary delegations.",
      )
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
      "Raw thread/realtime/start passthrough, merged last. threadId and realtimeSessionId overrides are rejected. Changing transport or outputModality can disable this TUI's audio path.",
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

export type OrchestratorValues = z.infer<typeof orchestratorValuesSchema>;
export type VoiceValues = z.infer<typeof voiceValuesSchema>;
export type ConfigValues = z.infer<typeof configValuesSchema>;

export const SERVER_KEYS: ReadonlyArray<string> = Object.keys(serverShape);
export const ORCHESTRATOR_KEYS: ReadonlyArray<string> = Object.keys(orchestratorValuesSchema.shape);
export const VOICE_KEYS: ReadonlyArray<string> = Object.keys(voiceValuesSchema.shape);
