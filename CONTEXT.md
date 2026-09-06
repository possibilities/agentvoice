# AgentVoice vocabulary

**Vanilla Codex** — The Codex client-and-server experience, including the voice
frontend and working agent. AgentVoice supplies its own frontend, so an explicit
value matching Codex's client can be part of vanilla behavior. Distinguish client
selection, app-server omission fallback and deliberate AgentVoice policy; omission
alone does not establish parity. See `docs/adr/0019-client-server-default-baseline.md`.

**AgentVoice controller / Console** — The retained foreground process: terminal
UI, exact workspace/thread identity, thread leases, durable control operations,
and private control transports. It is not a resident service and ends when the
foreground application quits.

**Voice runtime** — The disposable foreground child of the controller:
AgentVoice configuration/prompt/role loading, native audio/FFI, WebRTC,
`VoiceRuntime`, and its owned Codex child. A full runtime restart replaces it
while the controller and terminal stay open. RTP and PCM never cross controller
IPC.

**Codex child / app-server** — Unmodified `codex app-server`, launched and
owned by the voice runtime. Native RPC uses an authenticated loopback WebSocket;
stdio carries process diagnostics only. No resident service.
Codex can create its own tool processes. Runtime replacement or quit closes the
owned child/process group.

**Connection** — The runtime-private native WebSocket RPC channel to that child.

**TUI attachment** — A stock Codex TUI subscribing to the current live
orchestrator thread through a guarded local gateway. It follows native work and
submits typed input without owning voice or the child. Always available through
`agentvoice attach`; no launch opt-in or full-access requirement. Fresh, runtime
replacement and quit revoke it; redial preserves it. Joining preserves the live
thread's settings; explicit native setting changes and human answers flow through.

**Attachment gateway** — Runtime-owned authenticated loopback WebSocket proxy.
It validates exact thread/workspace before dispatch, filters unrelated/realtime
notifications, and forwards native human questions and correlated TUI answers.
Native Codex owns pending requests and replay; AgentVoice never races the TUI
with a refusal. A private controller bootstrap issues a short-lived admission
ticket; its native listener credential is never given to the TUI. See ADR 0022.

**Workspace** — The canonical existing root chosen once for this launch. Defaults
to launch cwd unless explicitly configured or overridden by --workspace. Used
for native conversation lookup and all AgentVoice-created threads. Not a sandbox.

**Full access** — Optional launch override: --allow-full-access explicitly selects
native danger-full-access / never. Without the flag, unset permission fields defer
to Codex; configured modes/profiles are accepted. Managed requirements still apply.
Native human interaction uses the attached stock TUI; unsupported client requests
are refused visibly.

**Conversation / main thread** — A native Codex thread tagged
agentvoice-orchestrator. Its saved history can continue across app launches.
Ordinary launch creates a new thread; explicit --continue selects the latest
eligible thread in the exact workspace.

**Orchestrator agent** — The working Codex agent on that main thread: tools,
filesystem work and native voice handoffs. The term is retained in config keys;
it does not imply an external orchestration daemon or custom continuation message.

**Voice agent** — Codex's realtime speech model, connected by WebRTC. Native
app-server handles delegation to the working agent.

**Voice session** — One realtime connection layered on a conversation. Redial
changes it without replacing the voice runtime, Codex child, or workspace.

**Runtime restart** — A controller-owned, durable operation that validates a
candidate runtime before it changes a live call, then replaces the current
runtime and resumes the exact retained thread. It reloads the pinned launch
inputs and loaded native artifact; it does not preserve live turns, delegated
work, realtime state, or native tool connections.

**Restart handoff** — Optional `handoffPrompt` attached to one runtime restart.
The retained controller privately saves it with the operation and submits it
once as labeled native task input after exact resume and media readiness.
Its submission status is separate from restart success, execution, and speech.
It does not edit prompts, replay automatically, or survive full controller quit.
Native `turn/start` starts or steers the backing agent; it is not a new worker
system. See `docs/adr/0016-restart-handoff.md`.

**Control plane** — A versioned private Unix socket and an authenticated,
loopback Streamable HTTP MCP projection owned by the controller. The injected
MCP entry is `agentvoice_control`; its capability is passed to the owned Codex
child only by environment variable. `status`, `redial`, and full `restart`
share one validated handler. See `docs/api.md`.

**Voice protocol** — AgentVoice defaults WebRTC requests to v3 for service
compatibility; explicit voice.version or voice.extra.version overrides win.
It aligns with the inspected desktop's conditional client-owned-call path.
The app-server's omitted-version fallback (v1 in Codex 0.153.3/0.153.4) is a
different reference, separate from the work model and --fast. Initial items
require effective v3.

**Fresh** — Stop old media and begin a new main thread in the same workspace.
Old history remains; native work in the old conversation stays there.
Ordinary launch uses this policy; --no-continue/--fresh makes it explicit.

**Continue / resume** — Explicitly resume native eligible working-thread history:
--continue selects the latest eligible thread, --resume chooses an exact ID.
No global thread.json pointer. AgentVoice does not read or inject saved speech
into new voice calls. Ordinary reconnects add no AgentVoice instruction; an explicit restart handoff
is a separate native task submission after connection readiness.

**Native voice context** — Explicit voice.extra.initialItems are passed through
unchanged, including empty and null values. Automatic spoken-history replay was
removed (ADR 0017); voice.replay-spoken-history is retired and errors at load.
Native saved history and working-thread continuation remain intact.

**Startup context / Recent Work** — Codex's bundled snapshot of working-thread
history, other recent conversations and machine/workspace layout. AgentVoice
omits voice.include-startup-context unless configured, allowing native inclusion.
Explicit false skips it and true requests it. Separate
from working-thread continuation and native global/workspace instructions.

**Prompt files** — Optional convention-named files in the selected config's
directory (VOICE_AGENT_SYSTEM_PROMPT.md, VOICE_AGENT_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md, VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_SESSION_START.md, VOICE_ORCHESTRATOR_SESSION_END.md), each one
native Codex control. Absent sends nothing; an empty file sends an empty string;
an override and an append for the same agent cannot coexist. Former names only
trigger warnings. Not shipped doctrine or a copied transcript. _Avoid_: prompt-files
(retired config key), seed files.

**Voice append** — VOICE_AGENT_APPEND_SYSTEM_PROMPT.md: text Codex concatenates
after its built-in voice prompt through the startup-context slot
(includeStartupContext true plus experimental_realtime_ws_startup_context). The
slot has one owner, so explicit startup-context settings conflict with the file.
_Avoid_: developer seed, startup snapshot (that is the native Recent Work text
the file displaces).

**CODEX_HOME** — Native Codex configuration/authentication/history location,
inherited unchanged from the launch environment. Codex resolves its default when
unset. AgentVoice does not manage login, profile homes or account switching.

**Runtime settings** — AgentVoice configuration and prompt file contents are
read by a preflighted runtime candidate and cached for that runtime's redial and
Fresh actions. A full runtime restart rereads the controller-pinned launch
provenance; it cannot adopt later shell-environment changes. Native Codex
settings/history retain their own rules.

**Startup config** — Explicit codex-config string array or repeatable -c /
--codex-config key=value, forwarded as native Codex -c arguments. File entries
precede CLI entries. This sets launch-wide native defaults, distinct from later
conversation/realtime overrides and persisted resume settings. Nothing is seeded
or hot-reloaded; --config still selects AgentVoice's JSON file.

**Role** — A directory naming what this launch's agents can do: skills/,
mcp.json, and prompt replacements or appends, shared with the agentroles CLI
for Claude Code and the Codex CLI. AgentVoice selects one with --role or the
role key; its prompt files replace the config directory's, its skills register
on the owned child only, and its MCP servers ride per-thread config. Not an
identity, account, or workspace. _Avoid_: capability, overlay, profile.

**Mute / hold** — M/S and channel clicks toggle the persistent mute assignment.
Space (with key releases) and the pointer PTT band temporarily unmute the mic;
each source releases only its own hold, and release never commits a toggle.

**Historical terms** — Resident, Server, Remote console, control attachment,
paired device, discovery, custom Worker, Worker report, account profile, idle
account rotation and Quiet resume (ADR 0010, retired by ADR 0012) refer to retired
implementations in old ADRs, not current runtime components. The current
controller/runtime split is a foreground parent/child topology, not a resident
server or cross-machine attachment feature. Local stock TUI attachment is the
mechanism described above. Native Codex subagents are separate from
the removed AgentVoice worker system.

**Lifecycle feed** — The retained controller's read-only Unix event endpoint for
current native thread state, inventory completeness, and runtime availability.
It survives runtime replacement, projects only bounded metadata, and provides
sequence-watermarked snapshots rather than a conversation log. _Avoid_: pipe,
control socket.

**Live voice item stream** — Typed native realtime item starts, transcript deltas,
and completions on the same read-only event endpoint. Preserves native identity
and content only in transit, with bounded best-effort delivery. No accumulation,
backfill, persistence or replay; lifecycle snapshots never supersede voice events.
_Avoid_: transcript database, speech-history replay, delivery guarantee.

**Conversation observation** — Read-only native orchestrator and subagent content
on the controller's event socket: typed items/deltas, bounded controller-memory
replay, live snapshots, and explicitly requested native history pages. It never
starts or resumes work and never feeds content into a voice call.
_Avoid_: speech replay, control attachment, transcript database.

**Live conversation snapshot** — A bounded projection of conversation items and
updates actually received by the controller, with an exact publication-sequence
cut. Its coverage is always partial; it is independent of native persisted history.

**Native history page** — An explicit read of persisted thread metadata, turns,
or items through the owned Codex child, scoped to an owned root and verified
descendants. Native reads are not atomic cuts of the event stream; revision fences
report observed overlap without inventing native snapshot guarantees.
