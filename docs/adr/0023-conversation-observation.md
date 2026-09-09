# 0023: Conversation observation for independent UIs

Extend the controller-owned read-only event socket to protocol 2 with typed native
conversation events, bounded in-memory replay and live-item snapshots, and explicit
native history reads scoped to leased roots and verified descendants, so clients
can render orchestrator and subagent conversations without taking ownership of
their execution. A live snapshot has an exact controller sequence cut; native
history has no equivalent atomic watermark and must be reconciled by item identity
and canonical completion, with explicit gaps, unavailable history and cursor expiry.
This expands [ADR 0018](0018-read-only-lifecycle-event-socket.md)'s observation boundary without a transcript database or UI;
voice items remain live-only and [ADR 0017](0017-remove-spoken-history-replay.md)'s prohibition on automatic speech-history
replay remains unchanged.
