# AgentHUD moved to its own project

AgentHUD now lives in `~/code/agenthud`, with its own source, tests, installation,
CLI/MCP, web UI and skill. Its Work database and `agenthud` command remain in place.
The maintained usage contract is `~/code/agenthud/docs/hud.md`.

AgentVoice supplies `agentvoice threads --json`: version 1 metadata-only output
`{schemaVersion, observedAt, monitor}` with exact observed identity, inventory,
thread hierarchy, turn status and settings. It owns no HUD store or service.
AgentStart owns `io.arthack.agenthud.serve` at `https://agenthud.localhost`.

See [ADR 0056](adr/0056-independent-agenthud.md), which supersedes ADR 0055's
colocated source and initial service deferral. Board historical access is preserved.
