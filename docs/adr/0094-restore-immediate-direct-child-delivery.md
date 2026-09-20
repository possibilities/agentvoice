# 0094: Restore immediate direct-child completion delivery

Superseded 2026-09-20 by
[0103](0103-retire-synthetic-subagent-lifecycle-steering.md), which retires the
underlying synthetic delivery path.

Accepted 2026-09-17 at the operator's request. This supersedes
[0092](0092-defer-direct-child-delivery-during-human-speech.md) and restores the
immediate-delivery rule in [0080](0080-direct-child-completion-delivery.md).

## Decision

AgentVoice submits each newly observed direct-child completion immediately through
the existing standalone `agentvoice.subagent_completion` native `turn/start`. It
does not inspect Realtime transcript segments or delay delivery while a user segment
is open. A busy root turn continues to receive the completion through native
steering.

The controller retains exact child/turn identity deduplication, and the runtime
retains same-`eventId` fingerprint and outcome-promise deduplication. Every native
submission is still attempted once. Refused, unavailable, and ambiguous outcomes
remain visible and are not retried automatically.

## Rationale

The speech-floor deferral introduced by 0092 was not shown to cause or prevent the
reported human interruptions. Keeping transcript observation, floor waiters, a
second asynchronous submission path, and a `deferred` delivery outcome adds state
and timing behavior without evidence that it improves the interruption problem.
Immediate delivery is therefore preferred until direct evidence supports a more
specific admission rule.

## Verification

Runtime checks cover immediate submission even while a native user transcript
segment is open, one `turn/start` for same-event retries, and rejection of a reused
event ID with a different fingerprint. Controller checks retain exact child/turn
deduplication across simultaneous observations and runtime replacement, plus the
existing no-retry checks for failed or ambiguous outcomes.
