# 0004: Mirror raw voice events without carrying audio

AgentVoice exposes raw realtime control events as an additive, authenticated,
live-only observation stream. Gateway peers explicitly request it with
`observe=voice`; the first observer enables the Client relay and the last
disables it. The Client assigns each offer a UUID, preserves that identity for
late events from superseded peers, and sends parsed event objects with a
per-session sequence. The server adds the authoritative orchestrator thread ID
and publishes starting, active, and ended lifecycle facts.

The relay is deliberately lossy and bounded. Client control traffic wins over
observation traffic: above 1 MiB of WebSocket backpressure, raw events are
skipped and later represented by one contiguous gap observation. The gateway
retains only a current starting or active lifecycle fact for a newly attached
observer; it never replays or persists raw events, gaps, or ended sessions.
Chats keeps the latest eight voice sessions in a model separate from threads,
with at most 300 raw event rows per session.

This boundary carries parsed `oai-events` control payloads, lifecycle, and
loss metadata only. It never carries WebRTC audio. Raw payloads can still
contain sensitive transcripts, context, tool arguments, and tool results, so
the feed remains both token-authenticated and explicitly opt-in.
