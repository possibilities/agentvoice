# 0049: Add a worker role with bounded assignment ownership

Accepted September 12, 2026. Extends
[ADR 0048](0048-universal-working-doctrine.md) with one new role, `worker`.
The existing `default` remains the manager role; no separate manager role is
created. The human accepted the revised doctrine report's worker recommendation
and explicitly kept both roles in AgentVoice for now. Universal fleet rollout,
AgentGuidance migration, and automatic native child-role injection are outside
this change.

A worker receives the same outcome ownership, proportional planning, evidence,
verification, useful bounded delegation, and personal resource boundaries, scoped
to its assignment. Its assignment owner is the parent for delegated work and
the human for a direct launch without a parent. Direct workers take assignments
and respond normally without finding a manager. They may execute the human's
authorized finishing steps; delegated workers normally return verified committed
work for the parent to integrate unless more finishing scope is assigned.

Every delegator establishes the child's default completion-return contract,
including the recipient, supported path, and evidence. A worker that creates a
child has the same obligation within its assignment. Native final-result delivery
can satisfy reporting without another message. Blockers, failures, and important
questions are raised when useful, not suppressed until success. Conversation
hold delays human presentation, never internal result return or authorized work.
The default append gains this necessary return-chain clarification.

The worker uses the existing general append and AgentVoice mode conventions from
[ADRs 0013](0013-convention-prompt-files.md), [0014](0014-roles.md), and
[0031](0031-role-owned-delegation.md). Its native mode permits adaptive delegation
without assigning the manager's unrelated conversation or portfolio duties.
Responsibility and runtime position differ: an explicitly launched worker may be
the root working thread of an AgentVoice call. Only that root, when supplied the
actual mailbox contract, receives the direct-child no-wait/wake-up behavior.
Ordinary native children cannot consume their parent's mailbox or assume that
the root's completion guarantee covers grandchildren. No new executor, registry,
worker-report service, or continuation guarantee is added. The worker root
discovers the mailbox tool's existing complete contract before dispatch rather
than duplicating its procedure in the mode hint.

Post-integration qualification found the inspected native `MultiAgentModeState`
truncates custom modes at 400 estimated tokens, using four UTF-8 bytes per token.
Both shipped modes exceeded that bound. Their mode files are shortened to native
activation and concise routing, leaving the detailed doctrine in the append
and mailbox tool contract. A shipped-role byte-bound check prevents request-mapping
tests from overlooking this downstream loss. The default's adaptive meaning is
unchanged. This is a source correction, not a claim that a live call was reloaded.
The existing isolated prompt-assembly probe, also run with its role path changed
to `worker` in a temporary copy, captured both shortened modes intact after the
append on start and replacement/resume with installed Codex 0.154.0. Responses
were local fixtures with external network denied; no hosted inference, credentials,
audio, or active call was involved. The temporary copy was removed.

The shared voice hold suffix is a relative link to the existing default role's
file. Convention-file loading follows it; explicit workspace-role capture saves
resolved bytes, yielding an independent snapshot under
[ADR 0042](0042-workspace-role-databases.md). Copying the raw worker directory
alone would leave that link without its source; preserve both source directories
or use the supported snapshot export. Both roles retain the same existing
startup-context-slot conflict rather than silently replacing an explicit setting.

`agentroles` loads the worker's general append in direct Codex/Claude sessions,
but ignores `VOICE_*` files there. Native tool restrictions, model/effort controls,
completion behavior, and inherited history remain native-owned. This source role
does not add a role parameter to `spawn_agent` or cause default-role children to
load the worker directory. Named lookup still uses the configured roles home;
an explicit source path works without global registration or a new installer.

The tradeoff is two readable responsibility variants rather than a new fragment
composition system. Shared standards should be kept aligned when changed; the
speech rule has one source. Tests load the shipped directories, check exact
native request mapping on start/resume and speech, and verify self-contained
snapshot capture. They establish configuration compatibility, not model compliance
or human-heard silence. Source edits do not update loaded sessions or independent
workspace snapshots. Runtime/voice trials and any active restart require their
own scope.
