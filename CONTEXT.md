# Glossary

**App-server** — The `codex app-server` child process this server supervises on
an owner-only Unix listener. AgentVoice and each gateway peer have independent
native connections to it. _Avoid_: "codex process", "backend server".

**App-server gateway** — The authenticated `/app-server` WebSocket surface
that gives every peer its own native App-server connection and forwards its raw
JSON-RPC frames without method translation. Closing a peer closes that physical
connection and releases its connection-scoped subscriptions. _Avoid_: "shared
connection", "virtual connection".

**Frame envelope** — The `agentvoice/frame` notification emitted by the
App-server gateway for every JSON frame crossing AgentVoice's own connection:
exact parsed payload plus direction and owner. A gateway peer's own native
frames remain ordinary App-server traffic, and the envelope stream is an
explicit `observe=agentvoice` opt-in. _Avoid_: "event" without
qualification (the payload may be a request, response, or notification), "chat
message".

**Codex transcript** — The per-thread semantic projection `agentvoice chats`
builds from a full `thread/read` history plus live Frame envelopes. It preserves
the raw App-server item on every projected item and never loads, resumes, or
subscribes to the thread it describes. _Avoid_: "chat messages" (commands,
diffs, reasoning, tools, and lifecycle are first-class), "voice transcript".

**Harness view** — The default Codex-thread detail surface in `agentvoice
chats`: a compact execution spine of Codex transcript items with expandable
content and per-item raw access. The alternate Frames view remains the exact
connection-level JSON stream; Voice Sessions use Frames only. _Avoid_: "chat
view", "semantic frames".

**Thread identity snapshot** — The `agentvoice/thread/identities` notification
replayed and updated for `observe=agentvoice` peers, mapping the currently
owned root and dispatched Worker thread ids to `orchestrator` or `worker`.
It is AgentVoice observer metadata layered beside untouched native App-server
frames, not a replacement for Codex's persisted Thread source. _Avoid_:
"thread list", "source repair".

**Thread source** — The per-thread `threadSource` ownership tag AgentVoice sets
to `agentvoice-orchestrator` or `agentvoice-worker`, independent of Codex's
process-level `source`. _Avoid_: `source`, "session source".

**Orchestrator agent** — The agent that does the actual work: one Codex thread
opened at boot, living in the workspace. The thread is its identity and its
persistent state; the voice session is layered onto it inside app-server.
_Avoid_: "orchestrator thread" for the actor, "conversation".

**Voice agent** — The realtime speech model the user actually talks to. It
holds the conversation and delegates execution to the orchestrator agent; the
handoff between them happens inside app-server. _Avoid_: "voice model",
"realtime model", "backend" (upstream's word for the orchestrator, not ours).

**Voice session** — One realtime (WebRTC) session connecting the client to the
voice agent, created per client offer, identified by an AgentVoice UUID before
its answer is applied, and superseded by the next offer. Late raw events remain
associated with the UUID of the peer that produced them.
_Avoid_: "call", "realtime conversation".

**Voice observation** — The live-only `agentvoice/voice-observation` gateway
notification enabled independently by `observe=voice`. It carries an exact
parsed realtime control payload, a lifecycle fact, or an explicit loss gap,
all associated with a voice-session UUID and the server-authoritative
orchestrator thread id. It is never persisted, and it never carries audio.
_Avoid_: "audio stream", "voice frame", "thread event".

**Voice observation lifecycle** — A `starting`, `active`, or `ended` fact for
one voice session. The gateway retains only the current starting/active fact
for a newly attached observer; ended facts are live transitions, not replayed
history. _Avoid_: "connection status" (the Client control socket and WebRTC
peer have distinct lifecycles).

**Voice observation gap** — One bounded loss record naming a contiguous range
of per-session raw-event sequence numbers skipped when Client control-WebSocket
backpressure exceeded 1 MiB. It makes loss visible without allowing telemetry
to delay offers or session control. _Avoid_: "dropped frame" (no audio or
App-server frame was dropped).

**Prompt file** — A conventionally named `SHOUTCASE.md` in the config
directory that primes one agent, discovered by name rather than referenced from
`server.json`. Absent leaves codex's built-in prompt; empty strips it. _Avoid_:
"system prompt" (ambiguous across the two agents).

**Workspace** — The directory the orchestrator agent operates in (codex thread
`cwd`); defaults to an agent-owned empty directory under the state dir.
_Avoid_: "cwd" (reserved for the app-server child's own working directory).

**Client** — The single WebSocket + WebRTC voice client. Audio flows
client↔voice agent peer-to-peer; only coordination flows through this server.
The bundled terminal client is `agentvoice client`. _Avoid_: "browser",
"surface".

**Remote console** — The phone-sized terminal control surface started with
`agentvoice remote` after SSHing into the Client's machine. It attaches to the
Client through owner-only local IPC and carries mute state, mute assignments,
and normalized activity levels—never audio. _Avoid_: "remote client" (the
Client remains the sole media peer), "phone app".

**Duplex audio device** — The bundled client's client-owned miniaudio device
and its only audio path: one `ma_device_type_duplex` whose native callback
moves raw PCM through a capture ring and a playback ring. It is independent of
OpenTUI's audio engine and stays open across redials. _Avoid_: "OpenTUI
audio".

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
a thread id. Its task outcome remains readable after its thread is retired;
completed turns are archived, while a thread whose first turn was definitively
rejected is deleted. _Avoid_: subagent (codex's in-thread feature,
deliberately disabled), background task.

**Worker cleanup** — retiring a Worker's app-server thread after its task
settles, tracked and retried separately from the task outcome. Archival
preserves a materialized turn's history while immediately shutting down its
runtime; deletion is reserved for a definitively pre-turn thread. _Avoid_:
status (the Worker's task result), unsubscribe (which only schedules a later
unload).

**Dispatch** — the `orchestrator.dispatch` surface: three dynamic tools
(`dispatch_worker`, `check_workers`, `cancel_worker`) declared on the
orchestrator's thread, answered by this server. _Avoid_: delegation (reserved
for voice→orchestrator), spawn.

**Worker report** — the `<worker_report>` turn the server starts on the
orchestrator's thread when a worker's turn completes, under
`orchestrator.dispatch-reports` (off by default — pull-only reading through
`check_workers`): status plus the worker's final message, trimmed. Arrives
mid-turn as steered input or opens a fresh turn. _Avoid_: callback,
notification (reserved for JSON-RPC).

**Account profile** — a per-account `CODEX_HOME` under
`~/.local/state/agentvoice/accounts/<slug>/`: its own `auth.json` (a separate
OAuth grant, refreshed only by codex) and private `app-server-control/`, with
session/config state symlinked to the canonical `~/.codex` so all accounts
share one session store and any thread resumes under any account. Onboarded with
`agentvoice accounts add`. _Avoid_: "account" alone (ambiguous with the
ChatGPT account it holds a grant for), "codex home swap".

**Balancer** — the external CLI consulted at child spawn when
`accounts.balance` is on: `agentusage balance codex`, falling back to
`codex-swap select`. Its pick is mapped to an account profile by email.
Transient refusals degrade to the canonical home; balancing configured with
codex-swap installed but nothing onboarded refuses to boot, with
instructions. _Avoid_: "load balancer", "router".

**Rotation** — the supervised child restart that moves the server to the
balancer's next pick after the active account crosses
`accounts.switch-threshold`, taken only when idle: no voice session, no
running orchestrator turn, no live workers. The orchestrator thread survives
via `thread/resume`; a voice session never does. _Avoid_: "failover",
"account switch" (suggests in-place switching, which codex cannot do).

**Signal field** — The shared text-mode visualization in the Client and Remote
console that maps the human and voice-agent activity envelopes into motion,
persistence, and collision at the contact fault. It visualizes energy and
turn-taking, not frequency content. _Avoid_: "spectrum", "spectrogram",
"equalizer" (the Duplex audio device does not expose frequency bins).
