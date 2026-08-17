# Glossary

**Resident** — The launchd-supervised `codex app-server` this system keeps
alive (`com.agentvoice.resident`), serving a private unix socket. Threads and
workers live in it, so they survive console restarts; its wrapper consults
the balancer at every spawn. _Avoid_: "daemon", "service", "backend server".

**App-server** — The `codex app-server` program the resident runs; spoken to
as JSON-RPC over WebSocket framing on its unix socket. _Avoid_: "codex
process".

**Console** — The one agentvoice process (`agentvoice`): TUI, duplex audio,
WebRTC peer, and the coordination runtime, attached to the resident. Audio
flows console↔voice agent peer-to-peer; only coordination crosses the
attachment. _Avoid_: "client" (the pre-collapse two-app term), "browser",
"surface".

**Attachment** — The console's connection to the resident: one WebSocket-
framed unix-socket connection with its own `initialize`. Reattach replaces
it after a drop; the resident and its threads persist across attachments.
_Avoid_: "connection" alone (ambiguous with the voice session), "reconnect"
for anything but this.

**Orchestrator agent** — The agent that does the actual work: one Codex thread
living in the workspace, persisted by id across console runs and resumed on
attach. The thread is its identity and its persistent state; the voice session
is layered onto it inside app-server. _Avoid_: "orchestrator thread" for the
actor, "conversation".

**Voice agent** — The realtime speech model the user actually talks to. It
holds the conversation and delegates execution to the orchestrator agent; the
handoff between them happens inside app-server. _Avoid_: "voice model",
"realtime model", "backend" (upstream's word for the orchestrator, not ours).

**Voice session** — One realtime (WebRTC) session connecting the console to
the voice agent, created per offer and superseded by the next offer. _Avoid_:
"call", "realtime conversation".

**Fresh** — Abandoning the persisted orchestrator agent for a new thread:
`--fresh` at start, or the console's `f` action live. The old session's
control plane stops silently and the console redials against the new thread.
_Avoid_: "reset", "new conversation" (the thread is the identity, not the
session).

**Prompt file** — A conventionally named `SHOUTCASE.md` in the config
directory that primes one agent, discovered by name rather than referenced from
`server.json`. Absent leaves codex's built-in prompt; empty strips it. _Avoid_:
"system prompt" (ambiguous across the two agents).

**Workspace** — The directory the orchestrator agent operates in (codex thread
`cwd`), shared by its workers; defaults to the user's home directory, so the
agent starts where the user's work already lives rather than in a pen of its
own. It is not scratch space: the agent makes a working directory per task for
the files that task produces. _Avoid_: "cwd" (reserved for the resident's own
working directory), "scratch directory".

**Remote console** — The phone-sized terminal control surface started with
`agentvoice remote` after SSHing into the console's machine. It attaches to
the console through owner-only local IPC (`console.sock`) and carries mute
state, persistent assignments, source-owned unmute holds, dB signal readings,
voice-session status, Redial, and Fresh—never audio. It and the Console host
the same TUI implementation. Both ship together, so the private IPC advances
in lockstep without compatibility shims. _Avoid_: "remote client" (the console
remains the sole media peer), "phone app".

**Duplex audio device** — The console's client-owned miniaudio device and its
only audio path: one `ma_device_type_duplex` whose native callback moves raw
PCM through a capture ring and a playback ring. It is independent of OpenTUI's
audio engine and stays open across redials. _Avoid_: "OpenTUI audio".

**Push-to-talk** — Momentarily opening an otherwise muted microphone while a
hold from the Console or a Remote console is active. The persistent mute
assignment does not change; releasing the hold or losing its input source
closes the microphone again. _Avoid_: "talk mode" (there is no separate mode),
"temporary unmute".

**Unmute hold** — A source-owned momentary opening layered over a channel's
persistent muted assignment; active holds keep it open until the last source
releases. It exists only when the channel was muted—pressing a live channel
waits until release to perform the ordinary toggle—and push-to-talk is the
microphone case. _Avoid_: "mute hold", "temporary toggle".

**Redial** — Negotiating a replacement voice session against the same
orchestrator agent while the current one keeps playing; audio swaps when the
replacement connects. Manual (`r`), or automatic for renewal and recovery.
_Avoid_: "reconnect" and "reattach" (reserved for the Attachment).

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

**Worker** — a sibling codex thread the orchestrator agent dispatches
asynchronous work to, with its own context and the orchestrator's execution
posture but none of its prompts. Addressed by a speakable handle (`w1`), never
a thread id. Workers live in the resident: they keep running while the console
is detached and are re-adopted on attach; only a resident restart makes one
`lost`. Its task outcome remains readable after its thread is retired;
completed turns are archived, while a thread whose first turn was definitively
rejected is deleted. _Avoid_: subagent (codex's in-thread feature,
deliberately disabled), background task.

**Thread source** — The per-thread `threadSource` ownership tag AgentVoice sets
to `agentvoice-orchestrator` or `agentvoice-worker`, independent of Codex's
process-level `source`. _Avoid_: `source`, "session source".

**Worker cleanup** — retiring a Worker's app-server thread after its task
settles, tracked and retried separately from the task outcome. Archival
preserves a materialized turn's history while immediately shutting down its
runtime; deletion is reserved for a definitively pre-turn thread. _Avoid_:
status (the Worker's task result), unsubscribe (which only schedules a later
unload).

**Dispatch** — the `orchestrator.dispatch` surface: three dynamic tools
(`dispatch_worker`, `check_workers`, `cancel_worker`) declared on the
orchestrator's thread, answered by the console. _Avoid_: delegation (reserved
for voice→orchestrator), spawn.

**Worker report** — the `<worker_report>` turn the console starts on the
orchestrator's thread when a worker's turn completes, under
`orchestrator.dispatch-reports` (off by default — pull-only reading through
`check_workers`): status plus the worker's final message, trimmed. Arrives
mid-turn as steered input or opens a fresh turn, and still publishes on
attach for turns that finished while the console was detached. _Avoid_:
callback, notification (reserved for JSON-RPC).

**Account profile** — a per-account `CODEX_HOME` under
`~/.local/state/agentvoice/accounts/<slug>/`: its own `auth.json` (a separate
OAuth grant, refreshed only by codex) and private `app-server-control/`, with
session/config state symlinked to the canonical `~/.codex` so all accounts
share one session store and any thread resumes under any account. Onboarded with
`agentvoice accounts add`. _Avoid_: "account" alone (ambiguous with the
ChatGPT account it holds a grant for), "codex home swap".

**Balancer** — the external CLI the resident's wrapper consults at every
spawn when `accounts.balance` is on: `agentusage balance codex`, falling back
to `codex-swap select`. Its pick is mapped to an account profile by email and
recorded in `resident.json`. Transient refusals degrade to the canonical
home; balancing configured with codex-swap installed but nothing onboarded
refuses console boot, with instructions. _Avoid_: "load balancer", "router".

**Rotation** — the resident restart (`launchctl kickstart -k`) the console
triggers after the active account crosses `accounts.switch-threshold`, taken
only when idle: no voice session, no running orchestrator turn, no live
workers. The wrapper's next pick is authoritative; the orchestrator thread
survives via `thread/resume` on reattach; a voice session never does.
_Avoid_: "failover", "account switch" (suggests in-place switching, which
codex cannot do).

**Signal field** — The shared text-mode visualization in the console and
Remote console: each activity envelope drawn as voice strands over a
continuously undulating background wash that dims while anyone speaks. It
visualizes energy and turn-taking, not frequency content; simultaneous voices
simply share the field, and nothing marks the overlap. _Avoid_: "spectrum",
"spectrogram", "equalizer" (the Duplex audio device does not expose frequency
bins), "contact fault" (retired with the clash rendering).
