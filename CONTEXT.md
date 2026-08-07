# Glossary

**App-server** — The `codex app-server` child process this server spawns and
speaks newline-delimited JSON-RPC to over stdio. _Avoid_: "codex process",
"backend server".

**Orchestrator thread** — The single Codex thread the server opens at boot; the
agent that does the actual work. The voice session is layered onto this thread
inside app-server. _Avoid_: "orchestrator agent", "conversation".

**Voice session** — One realtime (WebRTC) session on the orchestrator thread,
created per client offer and superseded by the next offer. _Avoid_: "call",
"realtime conversation".

**Workspace** — The directory the orchestrator thread operates in (codex thread
`cwd`); defaults to an agent-owned empty directory under the state dir.
_Avoid_: "cwd" (reserved for the app-server child's own working directory).

**Client** — The single WebSocket + WebRTC voice client. Audio flows
client↔voice model peer-to-peer; only coordination flows through this server.
_Avoid_: "browser", "surface".
