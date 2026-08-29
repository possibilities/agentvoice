# 0006: Enable fixed AgentStart skills per thread

AgentVoice keeps its independent resident Codex App Server for realtime voice,
but it no longer registers standalone roots or loads bare duplicates. On every
attachment it reads AgentStart's fixed `managed-skills.txt`; every
`thread/start` and `thread/resume`, orchestrator and worker alike, name-enables
the globally installed skills-only plugin's qualified `agent:<skill>` entries
through session config.

AgentStart persistently disables those names outside managed sessions, so the
plugin stays globally installed without leaking fleet capabilities. The
thread and rollout remain in Codex's native shared store, preserving resident
rotation, cross-account resume, history, and indexing.
