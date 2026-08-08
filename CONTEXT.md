# Glossary

**App-server** — The `codex app-server` child process this server spawns and
speaks newline-delimited JSON-RPC to over stdio. _Avoid_: "codex process",
"backend server".

**Orchestrator agent** — The agent that does the actual work: one Codex thread
opened at boot, living in the workspace. The thread is its identity and its
persistent state; the voice session is layered onto it inside app-server.
_Avoid_: "orchestrator thread" for the actor, "conversation".

**Voice agent** — The realtime speech model the user actually talks to. It
holds the conversation and delegates execution to the orchestrator agent; the
handoff between them happens inside app-server. _Avoid_: "voice model",
"realtime model", "backend" (upstream's word for the orchestrator, not ours).

**Voice session** — One realtime (WebRTC) session connecting the client to the
voice agent, created per client offer and superseded by the next offer.
_Avoid_: "call", "realtime conversation".

**Prompt file** — A conventionally named `SHOUTCASE.md` in the config
directory that primes one agent, discovered by name rather than referenced from
`server.yaml`. Absent leaves codex's built-in prompt; empty strips it. _Avoid_:
"system prompt" (ambiguous across the two agents).

**Workspace** — The directory the orchestrator agent operates in (codex thread
`cwd`); defaults to an agent-owned empty directory under the state dir.
_Avoid_: "cwd" (reserved for the app-server child's own working directory).

**Client** — The single WebSocket + WebRTC voice client. Audio flows
client↔voice agent peer-to-peer; only coordination flows through this server.
The bundled terminal client is `agentvoicenext client`. _Avoid_: "browser",
"surface".

**Redial** — Negotiating a replacement voice session against the same
orchestrator agent while the current one keeps playing; audio swaps when the
replacement connects. Manual (`r`), or automatic for renewal and recovery.
_Avoid_: "reconnect" (reserved for the WebSocket).

**Supersede** — What a new `thread/realtime/start` does to the running voice
session inside app-server: the old session's control plane stops silently (no
`closed` notification) and only its media path lingers. _Avoid_: "replace",
"preempt".

**Handshake gate** — The pure Origin/Host/token checks (`src/server/gate.ts`)
every HTTP request passes before it can reach the WebSocket. _Avoid_: "auth
middleware", "firewall".

**Connection token** — The shared secret the handshake gate requires on every
WebSocket handshake, persisted at `~/.local/state/agentvoicenext/token`
(mode 0600); the server creates it at first boot, the bundled client reads it
automatically. _Avoid_: "API key", "auth token", "password".
