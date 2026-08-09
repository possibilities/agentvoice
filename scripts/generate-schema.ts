/**
 * Generates `server.schema.json` from the same constants `config.ts` validates
 * with. The schema is the config surface's documentation — its descriptions
 * carry what the commented YAML example used to — so every key in SERVER_KEYS /
 * ACCOUNTS_KEYS / ORCHESTRATOR_KEYS / VOICE_KEYS must have a property spec
 * here; the build throws on a mismatch rather than emitting an undocumented or
 * phantom key.
 *
 * Regenerate with `bun run generate:schema`. `tests/schema.test.ts` fails when
 * the checked-in file drifts from this source.
 */
import { join } from "node:path";
import {
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
} from "../src/server/config.ts";

type Schema = Record<string, unknown>;

const str = (description: string): Schema => ({ type: "string", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const obj = (description: string): Schema => ({ type: "object", description });
const oneOf = (values: readonly string[], description: string): Schema => ({
  type: "string",
  enum: [...values],
  description,
});
const strings = (description: string): Schema => ({
  type: "array",
  items: { type: "string" },
  description,
});

const ACCOUNTS_PROPS: Record<string, Schema> = {
  balance: {
    ...bool(
      "Ask the balancer (`agentusage balance codex`, falling back to `codex-swap select`) which account to run on at every app-server child spawn. Needs profiles: `agentvoice accounts add <slug>` once per account — with codex-swap installed and none logged in, boot exits with the exact onboarding commands. Without the balancer CLIs, or on transient refusals, the server falls back to the canonical home loudly. Default: false (the canonical ~/.codex and whatever `codex login` put there).",
    ),
    default: false,
  },
  "switch-threshold": {
    type: "integer",
    minimum: 50,
    maximum: 100,
    description: "Utilization percent at which an idle child rotates to a better account.",
    default: DEFAULT_SWITCH_THRESHOLD,
  },
};

const ORCHESTRATOR_PROPS: Record<string, Schema> = {
  workspace: str(
    "The agent's working directory (its cwd; an AGENTS.md there applies). Tilde-expanded. Default: ~/.local/state/agentvoice/workspace.",
  ),
  dispatch: {
    ...bool(
      "Declare three dynamic tools on the orchestrator's thread — dispatch_worker, check_workers, cancel_worker — so it can run asynchronous work as sibling worker threads. Workers inherit the execution posture (sandbox, approvals, model, config) but no prompt files and no dispatch tools. Pull-only by default: results are read with check_workers. Default: false.",
    ),
    default: false,
  },
  "dispatch-reports": {
    ...bool(
      "Additionally push a <worker_report> turn at the orchestrator when a worker finishes — the evented mode a doctrine written for fire-and-forget expects. The tool descriptions promise whichever mode is on. Requires dispatch: true. Default: false.",
    ),
    default: false,
  },
  model: str(
    "Orchestrator model id. Mind the auth class: codex-branded models (gpt-5.3-codex …) are rejected on ChatGPT-account auth. Default: codex config.",
  ),
  effort: str(
    "Reasoning effort (none…ultra); sugar for model_reasoning_effort. An entry in orchestrator.config beats this shorthand. Note: ultra additionally switches on codex's proactive multi-agent mode. Default: codex config.",
  ),
  personality: oneOf(
    PERSONALITIES,
    "Orchestrator personality. Silently disabled when ORCHESTRATOR_BASE.md replaces the system prompt (the server warns at boot). Default: codex config.",
  ),
  sandbox: {
    ...oneOf(
      SANDBOX_MODES,
      "Execution sandbox for the orchestrator thread. NOT combinable with permissions — set one or the other.",
    ),
    default: "danger-full-access",
  },
  "approval-policy": {
    ...oneOf(APPROVAL_POLICIES, "When codex escalates for approval."),
    default: "never",
  },
  "approvals-reviewer": oneOf(
    APPROVALS_REVIEWERS,
    "Who reviews approval requests. auto_review gives escalations outside the sandbox an AI review (~3 s) instead of agentvoice's blanket fail-closed denial. Default: user.",
  ),
  permissions: str("Named permission profile. NOT combinable with sandbox — set one or the other."),
  "model-provider": str("Model provider id. Default: codex config."),
  "service-tier": str("Service tier. Default: codex config."),
  ephemeral: bool("Leave no persisted thread history. Default: false."),
  "history-mode": oneOf(HISTORY_MODES, "Thread history mode. Default: codex config."),
  "runtime-workspace-roots": strings(
    "Replaces the thread's workspace roots. Entries are tilde-expanded.",
  ),
  config: obj(
    "Raw ~/.codex/config.toml overrides, applied to this thread only. An entry here beats the effort shorthand above.",
  ),
  extra: obj(
    "Raw thread/start passthrough, merged last — anything the protocol accepts but this file does not name yet. Typos surface as RPC errors at boot, not as config errors.",
  ),
};

const VOICE_PROPS: Record<string, Schema> = {
  model: str("Realtime voice model id. Default: codex config / upstream."),
  name: str(
    "Voice timbre. v3 timbres: arbor breeze cove ember juniper maple sol spruce vale (alloy ash ballad cedar coral echo marin sage shimmer verse are v2-only and REJECTED under v3). Default: upstream.",
  ),
  version: {
    ...oneOf(
      REALTIME_VERSIONS,
      "Realtime protocol version. agentvoice defaults to v3 rather than deferring to codex config: seed items are v3-only, and the verified session semantics are v3's.",
    ),
    default: DEFAULT_REALTIME_VERSION,
  },
  "include-startup-context": bool(
    "Append a synthesized <startup_context> to the voice agent's instructions: the current thread, recent work across your other codex threads, and a depth-2 workspace tree. Worth false for an empty workspace. Default: upstream behavior.",
  ),
  "delegation-ack-filler": bool(
    "Let the voice agent emit a filler acknowledgement while the orchestrator works. Unset keeps the Realtime API's own behavior.",
  ),
  "codex-response-handoff-mode": oneOf(
    HANDOFF_MODES,
    "How orchestrator output is handed to the voice agent.",
  ),
  "codex-responses-as-items": bool(
    "Deliver orchestrator output as conversation items. Default: false.",
  ),
  "codex-response-item-prefix": str("Prefix for those conversation items."),
  "codex-response-handoff-channel-prefixes": {
    type: "object",
    additionalProperties: { type: "array", items: { type: "string" } },
    description:
      'Rename the bracketed channel markers per channel, e.g. {"final": ["[RESULT] "], "analysis": ["[THINKING] "], "commentary": ["[NOTE] "]}.',
  },
  "flush-transcript-tail-on-session-end": {
    ...bool("Route any leftover transcript tail through the orchestrator when the session ends."),
    default: false,
  },
  "client-managed-handoffs": {
    ...bool(
      "SHARP EDGE: true stops app-server from forwarding orchestrator output to the voice agent, expecting the client to append it explicitly. agentvoice never does, so true silently severs the two agents. Default: false.",
    ),
    default: false,
  },
  extra: obj(
    "Raw thread/realtime/start passthrough, merged last. outputModality and transport are owned by the server and belong here if you ever need them.",
  ),
};

/** Throws when a section's schema props and config.ts key list disagree. */
function assertCovers(section: string, props: Record<string, Schema>, keys: readonly string[]) {
  const have = Object.keys(props).sort();
  const want = [...keys].sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    throw new Error(
      `schema for "${section}" disagrees with config.ts keys\n  schema: ${have.join(", ")}\n  config: ${want.join(", ")}`,
    );
  }
}

export function buildSchema(): Schema {
  assertCovers("accounts", ACCOUNTS_PROPS, ACCOUNTS_KEYS);
  assertCovers("orchestrator", ORCHESTRATOR_PROPS, ORCHESTRATOR_KEYS);
  assertCovers("voice", VOICE_PROPS, VOICE_KEYS);

  const properties: Record<string, Schema> = {
    $schema: str("Reserved for editor tooling; agentvoice ignores it."),
    port: {
      type: ["integer", "string"],
      minimum: 1,
      maximum: 65535,
      description: "WebSocket port, bound to 127.0.0.1 only.",
      default: 7890,
    },
    codex: str(
      'The codex binary to spawn. Tilde-expanded. Default: $CODEX_PATH, else "codex" on PATH.',
    ),
    accounts: {
      type: "object",
      description:
        "Opt-in multi-account balancing over account profiles: per-account CODEX_HOMEs under ~/.local/state/agentvoice/accounts/, each holding its own auth.json with everything else symlinked to the canonical ~/.codex so every account shares one session store (threads resume across accounts).",
      properties: ACCOUNTS_PROPS,
      additionalProperties: false,
    },
    orchestrator: {
      type: "object",
      description: "Primes the orchestrator agent — the codex thread that does the actual work.",
      properties: ORCHESTRATOR_PROPS,
      additionalProperties: false,
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
    },
    voice: {
      type: "object",
      description: "Primes the voice agent — the realtime speech model the user talks to.",
      properties: VOICE_PROPS,
      additionalProperties: false,
    },
  };

  const topLevel = Object.keys(properties).sort();
  const expected = ["$schema", ...SERVER_KEYS].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(expected)) {
    throw new Error(
      `top-level schema keys disagree with SERVER_KEYS\n  schema: ${topLevel.join(", ")}\n  config: ${expected.join(", ")}`,
    );
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "agentvoice server configuration",
    description:
      "Configuration for `agentvoice server`, read once at boot from ~/.config/agentvoice/server.json ($XDG_CONFIG_HOME honored; --config relocates it). Precedence: CLI flag > this file > default. An option left unset is NOT sent to codex at all, so your ~/.codex/config.toml applies — which is why copying server.json.example verbatim is a no-op. Prompt files (VOICE.md, VOICE_SEED_DEVELOPER/USER/ASSISTANT.md, ORCHESTRATOR.md, ORCHESTRATOR_BASE.md, ORCHESTRATOR_SESSION_START/END.md) are discovered by convention in this file's own directory and are never named here; absent leaves codex's built-in prompt, present-but-empty strips it. See README.md for the prompt-file contract.",
    type: "object",
    properties,
    additionalProperties: false,
  };
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "server.schema.json");
  await Bun.write(path, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
