# AgentHUD moved to its own project

AgentHUD now lives in `~/code/agenthud`, with its own source, tests, installation,
CLI/MCP, web UI and skill. Its Work database and `agenthud` command remain in place.
The maintained usage contract is `~/code/agenthud/docs/hud.md`.

AgentVoice supplies `agentvoice threads --json`: version 3 metadata-only output
`{schemaVersion, observedAt, monitor}` with exact observed identity, loaded
inventory, persisted native descendants, parentage evidence, turn status and
settings. Each row also carries canonical collaboration task identity observed
from native thread-spawn metadata, or an explicit missing, malformed or
conflicting state. The exact revalidated root is the native session identity. Each row
reports whether parentage came from live inventory, persisted native history,
both, or has missing/conflicting evidence. Version 1 remains a rollout-compatible
input for AgentHUD but cannot claim durable history; versions 1 and 2 cannot
provide canonical task identity. AgentVoice owns no HUD store,
semantic Work association or service.
AgentStart owns `io.arthack.agenthud.serve` at `https://agenthud.localhost`.

See [ADR 0056](adr/0056-independent-agenthud.md), which supersedes ADR 0055's
colocated source and initial service deferral, and [ADR 0068](adr/0068-durable-native-parentage-export.md)
for the parentage boundary. Board historical access is preserved.
See [ADR 0091](adr/0091-export-canonical-collaboration-identity.md) for canonical
worker identity and rollout ordering.
