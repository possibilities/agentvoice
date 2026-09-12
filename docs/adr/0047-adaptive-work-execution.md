# 0047: Adapt work execution to the human's current intent

Accepted September 12, 2026. Partially supersedes
[ADR 0043](0043-adaptive-conversation-first-delegation.md): implementation,
edits and substantial execution no longer require delegation. The default
AgentVoice role applies the same judgment to all work: expected time to a correct
result, context and handoff costs, useful parallelism, and the value of keeping
the lead available for the current exchange. Brief coupled work may stay local;
substantial independent work is delegated when it benefits completion or
collaboration. The lead retains decisions, integration, verification and delivery.

A typed exchange can need an available lead, and a spoken request can ask for
sustained execution. The prompt follows the human's current intent rather than
assigning a workflow to the input channel. Explicitly supplied session context
and human preferences determine presentation; an unidentified environment is
not guessed. A typed message within a voice call does not establish a new mode.
The spoken conventions remain conditional on known voice context.

The lead continues requested work without requiring more conversation, offers
rather than assumes topic switches, and tracks unfinished requests and deferred
results. Background results can advance authorized dependencies silently while
their announcement waits for the current exchange to finish or a natural lull.
A verified result the human is awaiting should be delivered. Silence neither
cancels work nor expands authorization.

This change is limited to the default AgentVoice append and companion mode.
It changes no global or TUI configuration and creates no role. Native capability
checks, model/effort/context guidance, the exact mailbox protocol, direct call
controls, resource leases and emulator/VM permission requirements remain.
Source prompt changes do not migrate existing workspace role snapshots or
restart a call.

The tradeoff is greater lead discretion: it could retain work that would be
better delegated. Reassessment at execution boundaries and new human input
addresses that risk. Evaluate task completion, responsiveness, unnecessary
handoffs, intrusive announcements and lost work using small edits, long tasks,
corrections, queued completions and mixed input. Source and loading checks do
not prove behavioral equivalence between spoken and typed interaction; live
trials remain necessary.
