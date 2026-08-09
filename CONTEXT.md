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
The bundled terminal client is `agentvoice client`. _Avoid_: "browser",
"surface".

**Duplex audio device** — The bundled client's client-owned miniaudio device:
one `ma_device_type_duplex` whose native callback moves raw PCM through a
capture ring and a playback ring. It is independent of OpenTUI's audio engine
and stays open across redials. _Avoid_: "OpenTUI audio", "sox replacement".

**Redial** — Negotiating a replacement voice session against the same
orchestrator agent while the current one keeps playing; audio swaps when the
replacement connects. Manual (`r`), or automatic for renewal and recovery.
_Avoid_: "reconnect" (reserved for the WebSocket).

**Supersede** — What a new `thread/realtime/start` does to the running voice
session inside app-server: the old session's control plane stops silently (no
`closed` notification) and only its media path lingers. _Avoid_: "replace",
"preempt".

**Delegation** — The voice agent handing a user request to the orchestrator
agent: in realtime v3 it is server-side wiring that lands in the thread as a
`<realtime_delegation>` user turn. _Avoid_: "handoff" for this direction
(reserved for orchestrator→voice output), "tool call".

**Handoff** — Orchestrator output flowing back into the voice session as
delegation context, shaped by `voice.codex-response-*` options and capped at
~1,000 tokens per response. _Avoid_: "delegation" for this direction.

**Startup context** — The `<startup_context>` block codex synthesizes into the
voice agent's instructions at session start (current-thread tail, recent work
across the machine, workspace map); the only cross-session voice memory.
_Avoid_: "session memory", "context window".

**Session-boundary instructions** — `ORCHESTRATOR_SESSION_START.md` /
`ORCHESTRATOR_SESSION_END.md`: developer messages to the orchestrator wrapped
in `<realtime_conversation>`, delivered on voice-session open/close
transitions (not on renewals) and restated after compaction. _Avoid_: "session
prompts".

**Compaction** — Codex compressing the orchestrator thread's model-visible
history (~90% of the context window; summary plus recent user messages).
Base instructions are immune; developer instructions and AGENTS.md re-inject.
The voice session is never told. _Avoid_: "summarization", "truncation".

**Handshake gate** — The pure Origin/Host/token checks (`src/server/gate.ts`)
every HTTP request passes before it can reach the WebSocket. _Avoid_: "auth
middleware", "firewall".

**Connection token** — The shared secret the handshake gate requires on every
WebSocket handshake, persisted at `~/.local/state/agentvoice/token`
(mode 0600); the server creates it at first boot, the bundled client reads it
automatically. _Avoid_: "API key", "auth token", "password".

**Worker** — a sibling codex thread the orchestrator agent dispatches
asynchronous work to, with its own context and the orchestrator's execution
posture but none of its prompts. Addressed by a speakable handle (`w1`), never
a thread id. _Avoid_: subagent (codex's in-thread feature, deliberately
disabled), background task.

**Dispatch** — the `orchestrator.dispatch` surface: three dynamic tools
(`dispatch_worker`, `check_workers`, `cancel_worker`) declared on the
orchestrator's thread, answered by this server. _Avoid_: delegation (reserved
for voice→orchestrator), spawn.

**Worker report** — the `<worker_report>` turn the server starts on the
orchestrator's thread when a worker's turn completes: status plus the worker's
final message, trimmed. Arrives mid-turn as steered input or opens a fresh
turn. _Avoid_: callback, notification (reserved for JSON-RPC).
