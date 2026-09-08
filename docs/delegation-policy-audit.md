# Default-role delegation audit

Investigated September 8, 2026 against stock Codex CLI/app-server 0.153.4,
tag `rust-v0.153.4` (`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`).
The operator approved the conversation-first configuration and role alignment
on September 8; [ADR 0030](adr/0030-conversation-first-delegation.md) records that
choice. This remains explicit operator configuration, not an unconditional
AgentVoice runtime default.

## Finding

The default role's conversation-first delegation instructions conflict with
three independently supplied native instructions. A complete base-prompt
replacement does not remove those instructions.

`roles/default/APPEND_SYSTEM_PROMPT.md` asks the root to stay available to the
human, eagerly delegate substantial work, and select models and reasoning
efforts deliberately. AgentVoice sends that file as `developerInstructions`
on native thread start/resume (`src/core/config.ts`, `src/core/params.ts`).
It does not concatenate it onto the end of every native instruction.

Codex subsequently supplies:

1. A developer mode message: “Any earlier instruction enabling proactive
   multi-agent delegation no longer applies. Do not spawn sub-agents unless
   the user or applicable AGENTS.md/skill instructions explicitly ask for
   sub-agents, delegation, or parallel agent work.” Role appends are not one
   of the named exceptions.
2. A spawn-tool description: “Only call this tool for a concrete, bounded
   subtask that can run independently alongside useful local work; otherwise
   continue locally.” This differs from having the root hand off a single
   substantial blocking task to remain available for conversation.
3. A role message restricting explicit model/effort overrides to requests
   from the user, AGENTS.md, or skills. The same message correctly requires
   full-history forks to inherit their parent's model and effort.

These are developer instructions/tool metadata outside the replaceable base
prompt. Codex intentionally renders the mode message after its role guidance
and custom developer instructions. The selected base is separate again.

The inspected operator configuration selected the managed default role,
`gpt-6-astra`, and `low` effort. The managed role append was a symlink to the
canonical checkout's role file and matched this worktree. The local model
catalog snapshot reported client version 0.153.4 and fetch time
`2026-09-08T18:39:54.471666Z`; Astra's `model_messages.multi_agent.mode` was null.
For that snapshot, native low-effort resolution therefore selects the
explicit-request-only fallback. This is evidence about the inspected config
and catalog, not a capture of an already-running voice call or a universal
desktop rollout claim.

## Options

| Approach | What it resolves | What remains |
| --- | --- | --- |
| Put delegation and model-selection requests in an applicable skill or AGENTS.md | Uses the exceptions named by native policy; preserves the stock harness | Delegation must still fit the spawn tool's parallel-work rule. A skill must actually be loaded and applicable; catalog discovery alone is insufficient. Role policy in workspace AGENTS.md also affects other clients in that workspace. |
| Select Ultra effort | In the inspected catalog, native mode becomes proactive | Changes inference cost/latency; the spawn-tool and model-override restrictions remain. A configured or future catalog mode hint can supersede effort-based selection. |
| Supply `thread/start.multiAgentMode: "proactive"` | Nothing on 0.153.4 | The schema retains this deprecated field, but app-server ignores it. |
| Set a native custom multi-agent mode | Replaces the later cancelling message, independently of effort | A generic “delegate proactively” sentence leaves the other two restrictions unresolved. An intentional exception must address them explicitly. |
| Replace the complete base prompt | Replaces model base instructions | Leaves all three native additions in place and adds ongoing prompt-maintenance burden. |
| Patch the Codex harness | Can change the generated tool descriptions and role/mode fragments themselves | Requires maintaining a binary fork and revalidating runtime compatibility. Unnecessary for testing a scoped developer-policy override. |

## Approved conversation-first configuration

Preserve the role's existing intent: the root handles conversation, decisions,
coordination and integration; workers do substantial assignments. Use native
configuration to make that an explicit exception to the generic delegation
policy. Keep the stock base prompt, the current work model and effort, and
the existing permission controls.

The adjacent [configuration fragment](delegation-policy.example.json) contains
the approved policy. It uses the existing AgentVoice `orchestrator.config`
passthrough; no new AgentVoice prompt mechanism is needed:

```json
{
  "orchestrator": {
    "config": {
      "features.multi_agent_v2": {
        "enabled": true,
        "multi_agent_mode_hint_text": "The explicit conversation-first policy in delegation-policy.example.json"
      }
    }
  }
}
```

Use the actual text in the linked file, not this abbreviated illustration.
Merge the feature-table members with existing configuration; do not replace
the whole server configuration. The native key is under
`features.multi_agent_v2`, not a top-level `multi_agent_v2` table. Native
passthrough can silently ignore incorrectly located keys.

The configured mode explicitly supersedes the earlier per-task authorization,
parallel-local-execution and model-selection restrictions. It permits one
blocking delegated assignment, preserves local answers for brief questions,
and tells workers to execute rather than reflexively delegate their whole
assignment. It preserves native fork constraints, user steering, permissions,
approvals, capacity and workspace ownership.

This deliberately changes delegation policy. The old spawn description is
still present; the later developer mode supplies an explicit exception to it.
It is not a removal of the description or proof that a model will always
apply the exception correctly. Codex bounds custom mode text to 400 estimated
tokens; the approved 152-word text was observed intact in the request.

`features.multi_agent_v2.usage_hint_text` only appends to the V2 spawn
description; it does not replace its parallel-work sentence. Replacing the
root usage hint wholesale would also discard useful native guidance. Neither
is needed for this override.

If the desired product behavior is ordinary parallel delegation instead,
prefer an applicable role skill requesting bounded independent work and
model selection, and revise the append's promise that the root delegates any
work that pulls it away from conversation. That is a different product choice.

## Verification and rollout boundary

An isolated stock-binary probe used the native authenticated loopback WebSocket
transport and a localhost fake Responses endpoint. HOME, CODEX_HOME and the
workspace were disposable, with external network denied by macOS sandbox-exec.
The catalog snapshot was copied into the fixture explicitly. All responses
were fake; no live inference, credentials, audio, or active-call mutation was
involved. The owned child and temporary state were cleaned up.

Captured outbound request evidence:

| Fixture | Mode received by the model | Other evidence |
| --- | --- | --- |
| Role append, low effort | Explicit-request-only | Append in developer-message position 2, mode in position 4, counting from zero among developer items |
| Complete base replacement, low effort | Explicit-request-only | Replacement marker received; bounded-parallel spawn instruction remains |
| Deprecated proactive RPC field, low effort | Explicit-request-only | Field does not enable proactive mode |
| Ultra effort | Built-in proactive mode | Bounded-parallel spawn instruction remains |
| Custom mode through `features.multi_agent_v2` | Exact configured policy | Proposed text received without truncation after native role guidance; spawn description remains |

The repeatable [probe](../scripts/delegation-policy-probe.ts) additionally loads
the actual default role and example through AgentVoice's config/parameter
builders, verifies the baseline conflict, and checks the exact policy after
both a fresh thread and an exact resume in a replacement owned child:

```sh
CODEX_PATH="$HOME/.local/bin/codex" \
CODEX_MODEL_CATALOG="$HOME/.codex/models_cache.json" \
bun scripts/delegation-policy-probe.ts
```

It only reads the explicitly selected model catalog and copies it into
disposable state; it does not read credentials. Its baseline assertion is
deliberately version/catalog-sensitive so upgrades trigger a new audit.

The approved operator config is authored in AgentStart's
`config/agentvoice/server.json`, which the existing live configuration symlink
already selects. The role append is authored in AgentVoice's `roles/default`
and selected through the existing managed role symlink. Preserve those source
links; no second installation path is needed. The mode applies to calls using
that server configuration, even if another role is selected; operators wanting
different policies should use separate explicit configuration files.

This verifies request assembly, not delegation quality, responsiveness,
child-model choices, or whether speech is heard. A subsequent live trial should
cover an ordinary research request, one blocking implementation task, a brief
factual question, user steering during worker execution, and a worker requiring
approval. Check actual tool calls and model/effort choices. Active-call restart
and live inference/audio trials need their own scope. Files load on the next
runtime generation; this change does not restart an active call.

## Sources

- [OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents): direct user/project/skill triggering and native model defaults.
- [0.153.4 native mode text](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L7).
- [Mode resolution and model-override guidance](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/multi_agents.rs#L155), with the model-override restriction at line 50.
- [V2 spawn description](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L731).
- [Developer-message assembly order](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/mod.rs#L4029).
- [Feature-table configuration example](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/config/config_tests.rs#L11506).
- [Deprecated RPC field](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L107).
- [Mode text bound](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/context/world_state/multi_agent_mode.rs#L13).
