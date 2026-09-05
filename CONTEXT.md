# AgentVoice vocabulary

**AgentVoice app / Console** — The foreground process: TUI, audio, WebRTC and
coordination runtime in one program. There is no separately running AgentVoice Server.

**Codex child / app-server** — Unmodified `codex app-server`, launched and
owned by this app. Native JSONL over stdin/stdout; no resident socket or service.
Codex can create its own tool processes. Quit closes the owned child/process group.

**Connection** — The native stdio RPC channel to that child.

**Workspace** — The canonical existing root chosen once for this launch. Defaults
to launch cwd unless explicitly configured or overridden by --workspace. Used
for native conversation lookup and all AgentVoice-created threads. Not a sandbox.

**Full access** — Required execution posture: native danger-full-access / never,
verified on every thread start/resume. --allow-full-access is mandatory launch
consent, not a config setting. No approval UI; connector/tool interaction is
refused visibly and remains distinct from execution permissions.

**Conversation / main thread** — A native Codex thread tagged
agentvoice-orchestrator. Its saved history can continue across app launches.
The latest eligible thread in the exact workspace is the default selection.

**Orchestrator agent** — The working Codex agent on that main thread: tools,
filesystem work and native voice handoffs. The term is retained in config keys;
it does not imply an external orchestration daemon or custom continuation message.

**Voice agent** — Codex's realtime speech model, connected by WebRTC. Native
app-server handles delegation to the working agent.

**Voice session** — One realtime connection layered on a conversation. Redial
changes the voice session but not the conversation or workspace.

**Voice protocol** — Optional voice.version override on the native realtime
request. Unset defers to Codex's transport-specific default (WebRTC v1 in 0.153.3),
not necessarily the general realtime config or another Codex UI. Explicit v3 is
required for initial seed items; this is separate from the work model and --fast.

**Fresh** — Stop old media and begin a new main thread in the same workspace.
Old history remains; native work in the old conversation stays there.
--no-continue/--fresh selects this policy at launch.

**Continue / resume** — Read/resume native eligible history, with no transcript
copying or global thread.json pointer. --resume additionally chooses an exact ID.

**Prompt files** — Optional operator-provided markdown beside server.json.
Absent is native behavior; present and empty sends an empty string. Not a
shipped doctrine or automatically copied transcript.

**Account profile** — An optional per-account CODEX_HOME with its own login grant
and links to shared canonical session/config state. Idle rotation replaces this
app's child, not a launchd job.

**Mute / hold** — Persistent channel assignment versus a temporary unmute.
Each input source releases only its own hold; the last release restores mute.

**Historical terms** — Resident, Server, Remote console, control attachment,
paired device, discovery, custom Worker and Worker report refer to retired
implementations in old ADRs, not current runtime components. Native Codex
subagents are separate from the removed AgentVoice worker system.
