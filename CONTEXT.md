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

**Voice protocol** — AgentVoice defaults WebRTC requests to v3 for service
compatibility; explicit voice.version or voice.extra.version overrides win.
This frontend default is separate from native fallback (v1 in Codex 0.153.3),
the work model and --fast. Initial seed items require effective v3.

**Fresh** — Stop old media and begin a new main thread in the same workspace.
Old history remains; native work in the old conversation stays there.
--no-continue/--fresh selects this policy at launch.

**Continue / resume** — Resume native eligible working-thread history; default
and --continue select the latest eligible thread, --resume chooses an exact ID.
No global thread.json pointer. New voice calls restore recent saved speech from
that same thread unless voice.replay-spoken-history=false or explicit seeds win.

**Quiet resume** — AgentVoice's default WebRTC v3 reconnect instruction: wait
for new input instead of repeating old context. A developer initial item leaves
the native voice prompt intact. Explicit initial items or voice.quiet-resume=false
disable this default. It is model guidance, not a silence guarantee, independent
of spoken replay and the native startup snapshot.

**Spoken history replay** — AgentVoice reads native saved speech and sends it as
past conversation in v3 initialItems, without a separate persistent store. The
frontend setting voice.replay-spoken-history defaults true; false leaves the
working thread resumed but skips this read/replay. It cannot restore unsaved audio.

**Startup context / Recent Work** — Codex's bundled snapshot of working-thread
history, other recent conversations and machine/workspace layout. AgentVoice
defaults voice.include-startup-context to false; explicit true opts in. Separate
from selected-thread speech replay and native global/workspace instructions.

**Prompt files** — Optional files explicitly named in server.json's prompt-files
section. Relative paths use that config's directory. No reference sends no file
override; a referenced empty file sends an empty string. Conventional filenames
only trigger migration warnings. Not shipped doctrine or a copied transcript.

**CODEX_HOME** — Native Codex configuration/authentication/history location,
inherited unchanged from the launch environment. Codex resolves its default when
unset. AgentVoice does not manage login, profile homes or account switching.

**Launch settings** — AgentVoice configuration and explicit prompt contents read
once at launch, reused for redial and Fresh. Restart to apply edits, including
voice name; native Codex settings/history retain their own rules.

**Startup config** — Explicit codex-config string array or repeatable -c /
--codex-config key=value, forwarded as native Codex -c arguments. File entries
precede CLI entries. This sets launch-wide native defaults, distinct from later
conversation/realtime overrides and persisted resume settings. Nothing is seeded
or hot-reloaded; --config still selects AgentVoice's JSON file.

**Mute / hold** — M/S and channel clicks toggle the persistent mute assignment.
Space (with key releases) and the pointer PTT band temporarily unmute the mic;
each source releases only its own hold, and release never commits a toggle.

**Historical terms** — Resident, Server, Remote console, control attachment,
paired device, discovery, custom Worker, Worker report, account profile and idle
account rotation refer to retired implementations in old ADRs, not current runtime
components. Native Codex subagents are separate from the removed AgentVoice worker system.
