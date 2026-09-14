# AgentVoice vocabulary

**Persona** — An experimental, embeddable OpenTUI visual with explicit idle,
listening, thinking, speaking and asleep states. Optional input/output audio
features shape its motion; it neither infers conversation state nor owns a call.

**Android configurator** — A host browser design studio controlling a synthetic
native Halo preview over explicitly selected ADB. Fixed Rocker controls and
Traces routes have adjustable geometry, motion, colors and light. Preview state
owns no call or audio. Scoped resets and live edits remain unsaved until explicit
Save; even saved profiles do not adopt production defaults. The operator is
still exploring the design. See the [studio contract](android/configurator/README.md)
and [ADR 0041](docs/adr/0041-host-persona-configurator.md).

**Vanilla Codex** — The Codex client-and-server experience, including the voice
frontend and working agent. AgentVoice supplies its own frontend, so an explicit
value matching Codex's client can be part of vanilla behavior. Distinguish client
selection, app-server omission fallback and deliberate AgentVoice policy; omission
alone does not establish parity. See `docs/adr/0019-client-server-default-baseline.md`.

**Server** — The `agentvoice server` process, supervised by a macOS user LaunchAgent
or run manually, waiting on a private local socket. Its first frontend lazily
creates one retained workspace session. Frontend detach ends realtime media,
while server shutdown ends the workspace session and native work.

**Workspace session** — The server-lifetime controller, runtime and exact native
conversation created lazily by the first frontend. It pins one canonical workspace
and retains the Codex child, verified native work, leases, gateway, mailbox,
operation journal, transcripts and control/event endpoints across frontend detach.
Only explicit runtime replacement, `new_session`, or server shutdown changes the
parts named by those operations. _Avoid_: workspace session marker (the marker is
only the persisted root-thread pointer).

**Composition** — Bare `agentvoice`: one foreground smolmux process presenting the
pointer frontend, voice transcript and stock agent attachment side by side. All
three Apps use local PTYs and end with the smolmux process; there are no
Companion-held Sessions. Ordinary App exit/failure ends the Composition and its
media attachment; native work remains in the server's workspace session. Runtime
replacement reopens exact-thread attachments after live media;
input is never replayed. Attachments initially start only after this launch's call is live.

**Attachment view** — `agentvoice --attach`, run on desktop: two local PTYs for
voice transcript and stock agent, observing another frontend's call. It starts
no call/audio and closing it never stops that frontend. `--host <ssh-host>` keeps
smolmux and codex-viewer on desktop while SSH carries bounded transcript frames
and the backend's stock attachment TUI. Pin call, workspace, thread, controller
and generation; disconnect/replacement ends the view without replay. Native
attachment readiness is independent of media readiness. See ADR 0036.

**Frontend / Console** — The separate `agentvoice client` terminal process. Connecting
attaches media to the retained workspace session; its only controls are microphone mute, speaker mute and pointer
push-to-talk. It owns native audio, Opus and WebRTC, but no Codex process,
server configuration or thread leases. Both clients use frontend API v3 ([ADR 0033](docs/adr/0033-client-owned-native-media.md)).

**Frontend attachment** — One exclusive, disposable media owner connected to the
workspace session. Disconnect releases its hold and closes realtime voice and
client devices, without stopping the native runtime or work. A later attachment
may use a fresh clientId and negotiates fresh media with bounded same-root voice
context; there is no audio/input replay or automatic reconnect. _Avoid_: controller lifetime, native session.

**Phone frontend** — `agentvoice phone` plus its one-owner browser page on the
same Android/Termux device. The command serves a capability-bearing loopback URL;
the page requests microphone access only after an explicit tap and owns capture,
playback, codecs and WebRTC. Its WebSocket owns the media-attachment lifecycle. With a private
`--connect` profile, the bridge connects to the desktop WSS API instead of local
Termux; browser content and credentials remain separated. See ADRs [0032](docs/adr/0032-loopback-browser-media-frontend.md)/[0034](docs/adr/0034-authenticated-client-network.md).

**AgentVoice controller** — The server-owned authority for one workspace session:
exact workspace/thread identity, thread leases, operation journal, private control
and event transports retained across runtime replacements and frontend detach.

**Voice runtime** — The replaceable child of a workspace-session controller, owning
configuration/prompt/role loading and its stock Codex child. For every call the
client owns media and the runtime relays bounded SDP signaling only. Audio never crosses the frontend
socket or controller IPC.

**Codex child / app-server** — Unmodified `codex app-server`, launched and
owned by the voice runtime. Native RPC uses an authenticated loopback WebSocket;
stdio carries process diagnostics only. No resident service.
Codex can create its own tool processes. Runtime replacement or quit closes the
owned child/process group.

**Connection** — The runtime-private native WebSocket RPC channel to that child.

**TUI attachment** — A stock Codex TUI subscribing to the current live
orchestrator thread and its verified native descendants through a guarded local
gateway. It follows native work and
submits typed input without owning voice or the child. Always available through
`agentvoice attach agent`; no launch opt-in or full-access requirement. Runtime restart, server shutdown and native loss revoke it; frontend detach, redial and automatic
renewal preserve it. Joining preserves the live
thread's settings; explicit native setting changes and human answers flow through.

**Attachment gateway** — Runtime-owned authenticated loopback WebSocket proxy.
It validates the root or native descendant ancestry in the exact workspace before
dispatch, filters unrelated/realtime
notifications, and forwards native human questions and correlated TUI answers.
Hook trust is the only persistent native-config write: the gateway accepts only
an untrusted or modified key/hash pair returned by that attachment's current
`hooks/list` result for the selected workspace, and consumes that inventory on
one trust attempt.
Native Codex owns pending requests and replay; AgentVoice never races the TUI
with a refusal. A private controller bootstrap issues a short-lived admission
ticket; its native listener credential is never given to the TUI. The grant stays
bound to the root while the TUI navigates subagents. See ADRs [0022](docs/adr/0022-websocket-native-tui.md)/[0037](docs/adr/0037-descendant-tui-attachment.md).

**Workspace** — The canonical existing root pinned for one server workspace session. Explicit
--workspace wins over configuration; otherwise the default server selects its
current workspace directory when the first frontend starts the lazy session. Used for native conversation lookup
and all AgentVoice-created threads. Not a sandbox or necessarily a Git worktree.

**Workspace base** — `$XDG_STATE_HOME/agentvoice/default/workspaces/` (falling back
to `~/.local/state/agentvoice/default/workspaces/`), containing default voice-agent
workspace generations. The `default` namespace reserves room for named voice agents.

**Current workspace directory** — The generation with the newest sortable UTC
timestamp-and-UUID directory name inside the workspace base. Created initially
when absent, then selected afresh for each default server lifetime when its first
frontend creates the workspace session; file edits do not change selection and
the retained session keeps its selected directory.

**LaunchAgent** — The user-owned `io.arthack.agentvoice.server` launchd job that
starts the waiting default server at login and restarts it on exit. Its private,
installer-owned runtime bundle supplies the native client's stable macOS microphone
identity; it is distinct from the visible menu app. The server opens no audio or
Codex child until a frontend calls.

**Menu app** — The installed native macOS `AgentVoice.app`: a menu-bar status
surface and independently registered main-app login item. It observes the default
LaunchAgent without becoming a frontend or another server supervisor. Quitting
it or disabling its login item leaves the waiting server and any call running.
_Avoid_: Server (the LaunchAgent owns that lifecycle), client (it owns no call/media).

**Full access** — Optional launch override: --allow-full-access or file
allow-full-access:true explicitly selects
native danger-full-access / never. Without the flag, unset permission fields defer
to Codex; configured modes/profiles are accepted. Managed requirements still apply.
Native human interaction uses the attached stock TUI; unsupported client requests
are refused visibly.

**Conversation / main thread** — A native Codex thread tagged
agentvoice-orchestrator. Its saved history can continue across app launches.
Ordinary launch resumes the exact thread in the workspace's `.agentvoice-session`
marker, or creates and saves a thread when that file is absent.

**Orchestrator agent** — The working Codex agent on that main thread: tools,
filesystem work and native voice handoffs. The term is retained in config keys;
it does not imply an external orchestration daemon or custom continuation message.

**Voice agent** — Codex's realtime speech model, connected by WebRTC. Native
app-server handles delegation to the working agent.

**Voice session** — One realtime connection layered on a conversation. Automatic renewal
replaces it while preserving the voice runtime, Codex child and workspace.

**Control plane** — A versioned private Unix socket and an authenticated,
loopback Streamable HTTP MCP projection owned by the controller. The injected
MCP entry is `agentvoice_control`; its capability is passed to the owned Codex
child only by environment variable. MCP and the control socket expose status, voice redial and full runtime restart
with an optional handoff prompt, plus explicit new session, voice selection and
thread-mailbox opening. UI removal does not retire API controls. See `docs/api.md`.

**Voice protocol** — AgentVoice defaults WebRTC requests to v3 for service
compatibility; explicit voice.version or voice.extra.version overrides win.
It aligns with the inspected desktop's conditional client-owned-call path.
The app-server's omitted-version fallback (v1 in Codex 0.153.3/0.153.4) is a
different reference, separate from the work model and --fast. Initial items
require effective v3.

**Workspace session marker** — `.agentvoice-session` inside the canonical workspace,
containing the exact native main-thread ID as plain text. New server workspace sessions resume it;
absence creates and saves a thread. Invalid or unavailable saved history is an
error. Deleting the marker while no server session owns the workspace selects a
new session on the next lazy server start.

**New session** — An explicit MCP/API operation that preflights replacement, stops
the old runtime, clears the workspace marker and mailbox, creates and saves a
new main thread, and reconnects voice when attached within the same retained
workspace session.
Native history and old transcripts remain. _Avoid_: redial (voice only).

**Resume** — Native restoration of the workspace marker's exact main thread,
or the retained active thread during runtime restart. No latest-history selection,
input resubmission. Bounded speech context is restored separately. Conversation-selection flags
are retired.

**Native voice context** — Bounded recent completed speech from the exact workspace/root
voice transcript initializes each v3 call with historical, wait-for-new-input framing
([ADR 0066](docs/adr/0066-same-thread-voice-continuity.md)). Explicit voice.extra.initialItems
owns that slot unchanged, including empty/null values; other protocols and existingCall attachments bypass restoration.
This is not audio or input replay. voice.replay-spoken-history remains retired.
Native saved history and working-thread continuation remain intact.

**Startup context / Recent Work** — Codex's bundled snapshot of working-thread
history, other recent conversations and machine/workspace layout. AgentVoice
defaults includeStartupContext to false on every voice call, including renewal,
matching the inspected desktop client ([ADR 0029](docs/adr/0029-desktop-startup-context.md)). App-server omission means true.
Explicit true requests it; raw null restores server resolution. Separate
from working-thread continuation and native global/workspace instructions.

**Prompt files** — Optional convention-named files in the selected config's
directory (VOICE_AGENT_SYSTEM_PROMPT.md, VOICE_AGENT_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md, VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md, VOICE_ORCHESTRATOR_SESSION_START.md,
VOICE_ORCHESTRATOR_SESSION_END.md), each one
native Codex control. Absent sends nothing; an empty file sends an empty string;
an override and an append for the same agent cannot coexist. Former names only
trigger warnings. The explicitly selected AgentStart manager role carries its own mode
and append. _Avoid_: prompt-files
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

**Runtime settings** — AgentVoice configuration and prompt contents read during
runtime preflight and cached for that generation. Explicit runtime restart,
`new_session`, or a later server lifetime reloads files using the server's pinned
launch arguments. Frontend detach and reattach do not reload them.

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

**Workspace role** — An explicitly ejected, independently owned SQLite snapshot
of role settings and authored assets, bound to a canonical workspace. Source files
cease to be runtime inputs. Export/import creates reusable independent copies;
native authentication and history stay outside. See ADR 0042.

**Worker role** — The shipped `roles/worker` directory, responsible for one
assignment. Its owner/return recipient is the parent when delegated or the human
when launched directly. It may delegate useful bounded subtasks within native
capabilities. `roles/default` remains the manager role. Role responsibility does
not determine native thread ancestry: a worker-role launch can be a call's root,
and native subagent creation does not automatically select this directory.
_Avoid_: runtime worker (the disposable controller/runtime process is unrelated).

**Role revision** — An immutable saved settings/asset snapshot loaded at call
startup or runtime restart. Voice-only application records its own revision,
without claiming other pending settings loaded. Saved and applied are separate.

**Mute / hold** — Channel clicks toggle the persistent mute assignment. The
conditional pointer/browser push-to-talk button temporarily opens a muted
microphone; release, terminal blur/page loss or frontend disconnect closes that
hold.

**Browser media capability** — A 256-bit random token in the ephemeral
`http://127.0.0.1:<port>/<token>/` URL printed by `agentvoice phone`. Exact Host
and Origin checks plus one-owner admission keep it same-device. It is never a
native Codex/controller credential and must not be persisted, shared or widened
into remote access.

**Redial** — An MCP/API operation that replaces the voice connection while
keeping the runtime, loaded settings, native thread and stock TUI attachment.

**Runtime restart** — An MCP/API operation that preflights a replacement, stops
the old runtime and resumes its exact leased thread with reloaded code/settings.
The controller endpoints persist, whether or not a frontend is attached; active
native work is interrupted. Detached readiness does not imply live voice.

**Restart handoff** — Optional caller-provided work submitted once after restart
resumes the exact thread and reaches live media. Its separately journaled outcome
can be accepted, failed or unknown; native acceptance does not mean work completed.

**Historical terms** — Resident, Remote console, pairing, custom Worker reports,
account rotation, Quiet resume, in-call Fresh
name retired implementations in older ADRs. The current Server waits locally, normally as a LaunchAgent;
these retired implementations do not define its lifecycle.

**Lifecycle feed** — The retained controller's read-only Unix event endpoint for
current native thread state, inventory completeness, and runtime availability.
It lasts for one workspace session across frontend attachments, projects only bounded metadata, and provides
sequence-watermarked snapshots rather than a conversation log. _Avoid_: pipe,
control socket.

**Live voice item stream** — Typed native realtime item starts, transcript deltas,
and completions on the same read-only event endpoint. Preserves native identity
and content on the event socket with bounded best-effort delivery; the workspace-session controller
also saves received speech in its voice transcript. No backfill or replay; lifecycle snapshots never supersede voice events.
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

**Thread mailbox** — The workspace-session-controller-owned collection of pending completion
metadata for the orchestrator's direct native children. Opening returns and
clears a batch; each child terminal turn immediately sends a count-only wake-up
with a current working-child tally. It is not native child-result delivery or a
per-message read-receipt system.
_Avoid_: worker registry, transcript store.


**Voice transcript** — Automatic private JSONL observation of a workspace session's native voice
items, stored under state/voice/<canonical-workspace-hash>/<thread-id>.jsonl.
Resumed conversations append to the same file; recordings survive server shutdown.
`agentvoice attach voice` opens them with codex-viewer, independently of recording.
This is observed text, not proof of what was heard. Its bounded recent completed
speech supplies same-root voice context under ADR 0066, independently of the viewer.

**AgentHUD** — Independent durable Work, Assignment and Result owner in
`~/code/agenthud`, observed through its own web UI. AgentVoice supplies only
bounded versioned native metadata through `threads --json`. _Avoid_: runtime
work registry, AgentVoice-owned HUD, Board redirect.
