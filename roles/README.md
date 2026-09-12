# Shipped working roles

`default` is the existing human-facing manager role. `worker` owns one assignment
with the same standards for judgment, evidence, useful delegation, and completion.
There is no separate `manager` directory. Both roles remain authored in AgentVoice;
this change adds no fleet-wide prompt deployment or shared-fragment loader.

## Select worker explicitly

From this repository, inspect or launch the existing role-directory format:

```sh
agentroles show ./roles/worker
agentroles ./roles/worker -- codex
agentroles ./roles/worker -- claude
agentvoice server --role ./roles/worker
```

Use an absolute role path when launching from the assigned project or worktree.
A bare `worker` name resolves under `$AGENTROLES_HOME` or `~/.config/agentroles`,
as before; adding this source directory does not register a global alias. This
role adds no skills or MCP servers, so it needs no Codex skill-plugin installation.
Existing harness tools, skills, permissions, model/effort settings, and user
overrides retain their normal ownership.

When delegated, the worker reports to its parent. When launched directly without
a parent, it takes the human's assignment and reports to the human. It need not
find or create a manager. A worker may delegate a useful bounded subtask within
the assignment and available native controls. Every delegator establishes the
child's default return contract; completion evidence and necessary earlier
escalation flow up the chain. Native final-result delivery satisfies reporting
without a duplicate completion message. A human conversation hold delays human
presentation, not execution or internal result return.

Delegated repository work normally ends in verified committed changes for the
parent to integrate. A parent may assign additional finishing steps. A directly
launched worker carries out the human's authorized delivery request itself;
it does not acquire unrelated manager responsibilities. Active app/call restart
still requires separate current authorization.

## Role responsibility and runtime capability are separate

AgentVoice loads `APPEND_SYSTEM_PROMPT.md` into the selected root thread's
`developerInstructions`. The worker's `VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md`
enables the existing adaptive native mode for that AgentVoice launch. Its mailbox
guidance applies only if this thread is the actual root of a call supplying the
mailbox. That root discovers the mailbox tool's complete procedure before
dispatch. A worker launched as that root can use its direct-child completion
notices. Ordinary native children cannot open their parent's mailbox and must
use their own host's completion mechanism; the root's guarantee does not cover
their descendants.

`agentroles` gives Codex CLI and Claude Code the general append but ignores
`VOICE_*` files. Their native delegation and model-selection restrictions still
apply. The prose cannot activate AgentVoice's mode or wake-up mechanism there.
This role does not add a native `spawn_agent` role argument, assign `worker` to
every child of `default`, redact inherited history, or launch another harness
automatically. A parent chooses an explicitly supported role launch when it
wants this exact role; native subagents continue to receive their native role
and context plus the parent's bounded brief. The default append's completion
return guidance applies to those briefs too.

The voice append is a relative link to the default role's existing speech hold
instructions, keeping one source of that shared wording. Preserve both role
directories when distributing the source tree. Explicit workspace-role ejection
captures resolved bytes, so the exported/materialized role is self-contained.
The speech suffix retains the existing startup-context-slot contract: competing
explicit startup-context settings fail validation rather than being overwritten.

## Maintenance and verification

Keep the general working standards in `default` and `worker` aligned when a
shared policy changes, while preserving their different responsibility and
return recipients. Keep exact root mailbox semantics aligned with the
[mailbox contract](../docs/thread-mailbox.md). Prefer the current plain role
files and shared speech link over a new composition framework.

Keep each native mode at or below 1,600 UTF-8 bytes. The inspected native
`MultiAgentModeState` truncates custom text at 400 estimated tokens using four
bytes per token. Put full working doctrine in the append and rely on the
mailbox tool's existing contract for its procedure; a successful request mapping
does not prove that an oversized mode reaches the model intact.

The shipped-role tests load both actual directories, verify start/resume and
speech request slots without replacing native base prompts or operator settings,
enforce that native mode bound, and round-trip the worker through an independent
workspace-role snapshot. They make no native inference or media calls and do not
establish live model behavior. The existing isolated native prompt-assembly
probe also verified the shortened mode after the append on start and
replacement/resume for both roles with Codex 0.154.0 and local fake Responses.
Existing prompt-conflict tests remain the authority for incompatible settings.
Role source edits load on a later launch or authorized runtime replacement;
they do not migrate snapshots, change an existing TUI, or restart a call.

See [ADR 0049](../docs/adr/0049-worker-role.md) for the accepted scope and limits.
