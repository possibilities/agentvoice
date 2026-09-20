# 0092: Defer direct-child delivery during human speech

Superseded 2026-09-20 by
[0103](0103-retire-synthetic-subagent-lifecycle-steering.md), which retires the
underlying synthetic delivery path.

Accepted 2026-09-16. This amends [0080](0080-direct-child-completion-delivery.md)'s
immediate-delivery rule at the voice admission boundary.

Superseded 2026-09-17 by
[0094](0094-restore-immediate-direct-child-delivery.md). The speech-floor deferral
was not shown to cause or prevent the reported interruptions, so AgentVoice returned
to the simpler immediate-delivery rule while further evidence is gathered.

## Decision

When native Realtime reports an open root-thread user `transcriptSegment`, AgentVoice
retains a newly observed direct-child completion in the active runtime and returns a
bounded internal `deferred` outcome to the controller. It submits the existing named
`agentvoice.subagent_completion` `turn/start` once every user segment in that Realtime
session completes. An assistant transcript item does not release the floor. A Realtime
session close clears its remaining user segments and releases the deferred delivery.

The controller must not wait for human speech through its twelve-second worker IPC
deadline. `deferred` therefore settles that IPC request immediately; the runtime retains
the exact event ID, fingerprint, and one eventual native submission. A failed eventual
submission emits a warning and is not retried. Shutdown releases the waiter so it can
settle unavailable under the existing runtime-replacement/no-replay rules.

## Boundary

This decision covers only the `turn/start` AgentVoice itself submits for direct-child
completion delivery. Root commentary is handed from Codex to Realtime internally and
appears to AgentVoice only as an already-admitted assistant transcript item. Cancelling
or delaying that path would require a client-managed handoff implementation and a
separate product decision; setting `clientManagedHandoffs` alone disables native
forwarding without supplying that implementation.

## Verification

Regressions cover a child completion arriving during an open user segment, assistant
commentary that must not release it, user completion that does, and a Realtime session
close that releases an incomplete user segment. They also retain the prior direct-child
identity, deduplication, and no-retry coverage from [0080](0080-direct-child-completion-delivery.md).
