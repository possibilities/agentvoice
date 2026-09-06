/**
 * The `server.json` surface as a zod schema — the single source of truth:
 * `config.ts` validates file values with it at load, and
 * `scripts/generate-schema.ts` emits `server.schema.json` from it, so a config
 * key exists exactly when it is declared (and described) here.
 *
 * Contract:
 * - Every field is `.optional()` and none carries a zod `.default()`: an unset
 *   key must stay unset through parse. Documented application defaults apply
 *   during resolution or request construction; other unset fields stay omitted.
 *   The `default` entries in `.meta()` document behavior, not parse-time values.
 * - The root, `orchestrator`, and `voice` reject unknown keys. Prompt overrides are
 *   convention-named files beside the config, not keys (see config.ts).
 *   `strictObject` alone does not finish that job: zod skips a literal own
 *   `__proto__` key, so `config.ts` scans the raw document for it separately.
 *   `orchestrator.config`, `orchestrator.extra`, and `voice.extra` are open
 *   passthroughs into the codex key space and must stay open.
 * - `$schema` appears only in the published-file schema; the loader tolerates
 *   and strips it before validation, whatever its value.
 */
import { z } from "zod";
import { codexConfigEntryIssue } from "./codex-config.ts";

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

/** WebRTC service compatibility, not Codex's omitted-version fallback. */
export const DEFAULT_WEBRTC_VERSION: RealtimeVersion = "v3";

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
        "Reasoning effort (none…ultra); sugar for model_reasoning_effort. An entry in orchestrator.config beats this shorthand. Model support and subagent behavior belong to Codex; this field does not promise a multi-agent mode. Default: Codex configuration.",
      )
      .optional(),
    personality: z
      .enum(PERSONALITIES)
      .describe(
        "Orchestrator personality. A custom baseInstructions prompt may supersede native personality behavior. Default: Codex configuration.",
      )
      .optional(),
    sandbox: z
      .enum(SANDBOX_MODES)
      .describe(
        "Native sandbox mode. Unset inherits native configuration. NOT combinable with permissions. --allow-full-access overrides permission selectors at launch; managed requirements still apply.",
      )
      .optional(),
    "approval-policy": z
      .enum(APPROVAL_POLICIES)
      .describe(
        "Native approval policy. Unset inherits native configuration. --allow-full-access requests never. Use agentvoice attach to answer native approvals and tool questions; Codex keeps them pending when no TUI is attached.",
      )
      .optional(),
    "approvals-reviewer": z
      .enum(APPROVALS_REVIEWERS)
      .describe(
        "Native reviewer passthrough; --allow-full-access requests the never approval policy. This does not grant connector consent or answer questions. Default: native configuration.",
      )
      .optional(),
    permissions: z
      .string()
      .describe(
        "Native permission profile. Unset inherits native configuration. NOT combinable with sandbox. --allow-full-access overrides this selection at launch.",
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
      .describe(
        "Native history representation. Unset lets app-server choose based on thread-store capabilities (Codex 0.153.3); resume retains the saved mode.",
      )
      .optional(),
    "runtime-workspace-roots": z
      .array(z.string())
      .describe(
        "Replaces the thread's workspace roots. Entries are tilde-expanded; relative entries resolve inside the selected workspace.",
      )
      .optional(),
    config: passthrough(
      "Raw ~/.codex/config.toml overrides, applied to this thread only. --allow-full-access overrides permission selectors; native managed requirements still apply. An entry here beats the effort shorthand above. experimental_realtime_ws_startup_context replaces Codex's generated voice startup snapshot when startup context is enabled; an empty string suppresses that snapshot without erasing thread history.",
    ).optional(),
    extra: passthrough(
      "Raw thread/start or thread/resume passthrough, merged last except workspace, AgentVoice source identity and explicit --allow-full-access. --allow-full-access overrides permission selectors; native managed requirements still apply. Conflicting cwd and threadId/path/history overrides are rejected. Known start-only fields are stripped on resume after merging extra (Codex 0.153.3). Nonempty dynamicTools warns: metadata is passed on start but this client has no handlers. Raw fields can override named CLI flags; extra.config replaces the assembled config object. Unknown native fields may be silently ignored.",
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
        "Voice timbre, validated by Codex when voice starts. Loaded once per launch; restart to change. Current v1/v3 timbres: arbor breeze cove ember juniper maple sol spruce vale. Legacy v2 timbres are incompatible with WebRTC. With AgentVoice's v3 default, unset honors Codex's configured realtime voice, then its v3 timbre default. Raw version:null restores the native WebRTC v1 fallback and ignores that configured voice (Codex 0.153.3); explicit voice.name still passes through.",
      )
      .optional(),
    version: z
      .enum(REALTIME_VERSIONS)
      .meta({
        description:
          "Realtime protocol override. AgentVoice defaults WebRTC requests to v3 for service compatibility; this is a frontend transport default, not Codex's omitted-version fallback. Explicit values and final voice.extra.version overrides win, including null for native fallback (WebRTC v1 in Codex 0.153.3, currently rejected by the service tested here). Alternate raw transports receive no compatibility default. WebRTC rejects v2; initial seed items require effective v3.",
        default: DEFAULT_WEBRTC_VERSION,
      })
      .optional(),
    "include-startup-context": z
      .boolean()
      .meta({
        description:
          "Native startup snapshot: working-thread history, Recent Work from other conversations, and a machine/workspace map. Omitted defers to Codex's native resolution (currently includes the snapshot for a new voice call). Explicit false skips it; true includes the whole snapshot. Codex has no Recent Work-only switch. Independent of working-thread continuation. When enabled, orchestrator.config.experimental_realtime_ws_startup_context replaces the snapshot (empty string suppresses it). Raw voice.extra.includeStartupContext still wins, including null for native resolution.",
      })
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
          "Unsupported client mode: true disables native response forwarding, expecting explicit client append calls that AgentVoice does not implement. A visible launch warning explains the broken handoff; the raw value is still forwarded. Omitted defers to Codex (currently false).",
      })
      .optional(),
    extra: passthrough(
      "Raw thread/realtime/start passthrough, merged last. threadId and realtimeSessionId overrides are rejected. Overriding the generated WebRTC transport or selecting non-audio output warns visibly: this TUI has no alternate media path. Raw values still forward; this is not a supported-mode guarantee.",
    ).optional(),
  })
  .meta({
    description: "Primes the voice agent — the realtime speech model the user talks to.",
  });

const serverShape = {
  "codex-config": z
    .array(
      z.string().superRefine((entry, ctx) => {
        const message = codexConfigEntryIssue(entry);
        if (message) ctx.addIssue({ code: "custom", message });
      }),
    )
    .describe(
      "Explicit native startup overrides as key=value strings (TOML values, dotted keys). Forwarded unchanged as separate Codex -c arguments, with file entries before repeatable CLI entries; later entries win within that layer. Empty/unset adds nothing. Launch-only, no global config writes. Conversation-level overrides remain separate; workspace/realtime invariants still apply. --allow-full-access appends native permission overrides after these entries.",
    )
    .optional(),
  codex: z
    .string()
    .describe(
      'The codex binary to spawn. Tilde-expanded. Default: $CODEX_PATH, else "codex" on PATH.',
    )
    .optional(),
  role: z
    .string()
    .describe(
      "Role for this launch: a directory path, or a name under $AGENTROLES_HOME (default ~/.config/agentroles). The role directory replaces this file's directory as the prompt source (SYSTEM_PROMPT.md/APPEND_SYSTEM_PROMPT.md for the orchestrator plus the VOICE_* files), adds its skills/ directory to the owned Codex child, and adds mcp.json servers to the conversation. --role overrides this value. Default: no role.",
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
