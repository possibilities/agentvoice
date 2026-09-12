# 0043: Adapt delegation to the conversation and the work

Partially superseded September 12, 2026 by
[ADR 0047](0047-adaptive-work-execution.md): adaptive execution also covers
implementation, edits and substantial work; mandatory delegation is removed.
The earlier decision and its evidence are preserved below.

Accepted September 10, 2026. Partially supersedes
[ADR 0031](0031-role-owned-delegation.md)'s mandatory delegation for read-only
work and thinking, and the same requirement retained by
[ADR 0040](0040-deliberate-subagent-routing.md). Selected-role ownership,
explicit native mode delivery, worker routing and permission boundaries remain.

The natural-language voice trial correctly applied Maple and Cove, preserving
the working process, thread and generation. Each voice application took about
1.1 seconds, but request-to-spoken-completion delays were approximately 36 and
23 seconds. Delegation, overly broad tool discovery, result delivery and repeated
progress narration added overhead around a short call-control operation.

The root now chooses direct execution or delegation for read-only searches,
lookups, source inspection, research, planning and analysis. It weighs expected
time to a correct result, context needs, briefing/startup/review overhead and
useful parallelism. Local investigation to make that choice is permitted.
Independent actionable tasks should still run concurrently where useful,
including work that can overlap new requests or the conversation. Implementation,
edits and substantial execution remain delegated, except routine AgentVoice
call controls; explicit human instructions to work locally still win.

The root briefly announces meaningful handoffs and what each worker will do,
grouping related assignments into a natural update. If local work grows or the
human changes attention, it can hand off the remaining work with its findings,
constraints and next steps. It retains responsibility and avoids duplicate work.
“Background” means a real worker or process is running; paused work is described
as paused. Attention changes at an available execution boundary, without a
promise to interrupt a blocking tool instantly. Existing mailbox handling and
completion reconciliation remain unchanged.

Routine call controls use available AgentVoice tools directly, with narrow
discovery, the requested application timing, outcome verification and one brief,
specific completion response. Changing a live setting does not imply source
editing. Detailed arguments and operation semantics stay in tool descriptions;
this does not add another tool catalog or replace the native voice prompt.

Both default-role prompt files carry compatible instructions; later routing
advice and current documentation no longer require quick read-only tasks to be
delegated. Historical audit evidence remains dated and linked to this decision.
The policy is stored as prompt assets when a role is ejected. Updating default
files does not migrate existing databases: approved workspace prompt changes
must create an immutable revision, preserving other settings and assets, and
load on the next call or explicit runtime replacement. No watcher or automatic
restart is introduced. Prompt loading can be validated without audio/inference;
responsiveness and routing quality need another natural-language live trial.
