# AgentHUD moved to its own project

AgentHUD now lives in `~/code/agenthud`, with its own source, tests, installation,
CLI/MCP, web UI and skill. Its Work database and `agenthud` command remain in place.
The maintained usage contract is `~/code/agenthud/docs/hud.md`.

AgentVoice supplies `agentvoice threads --json`: version 2 metadata-only output
`{schemaVersion, observedAt, monitor}` with exact observed identity, loaded
inventory, persisted native descendants, parentage evidence, turn status and
settings. The exact revalidated root is the native session identity. Each row
reports whether parentage came from live inventory, persisted native history,
both, or has missing/conflicting evidence. Version 1 remains a rollout-compatible
input for AgentHUD but cannot claim durable history. AgentVoice owns no HUD store,
semantic Work association or service.
AgentStart owns `io.arthack.agenthud.serve` at `https://agenthud.localhost`.

See [ADR 0056](adr/0056-independent-agenthud.md), which supersedes ADR 0055's
colocated source and initial service deferral, and [ADR 0068](adr/0068-durable-native-parentage-export.md)
for the parentage boundary. Board historical access is preserved.
