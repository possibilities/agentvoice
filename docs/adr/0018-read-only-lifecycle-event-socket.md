# 0018: Observe lifecycle state through a separate Unix socket

Accepted 2026-09-05. The retained controller owns a read-only event endpoint beside its mutation-capable control endpoint, sharing NDJSON framing and bounded writes while keeping subscriptions out of control/MCP dispatch. Native thread state is projected through bounded runtime IPC; sequence-watermarked snapshots recover UI state across reconnects and generation resets without retaining conversation content or promising a durable event log. Envelopes follow agentmux/smolmux, prefix matching follows agentsource, and `event.subscribe` plus `state.get` define the proposed common event-endpoint methods.


Extension accepted 2026-09-05: the same endpoint also carries typed native voice item starts, transcript deltas and completions as a transient stream. Lifecycle state remains content-free. Native item identity and content are forwarded through bounded IPC without accumulation, persistence, backfill, replay or a transcript UI. Lifecycle snapshot watermarks do not supersede voice events. Item bodies are omitted from native receipt debug logs; existing general debug behavior is otherwise unchanged.
