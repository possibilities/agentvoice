# AgentVoice manual

This is the detailed operating and reference guide. For the short project
overview and current readiness caveat, see the [README](../README.md).

A local Codex voice server with terminal and same-device browser frontends.
`agentvoice server` restores saved work or waits for a first frontend. Bare
`agentvoice` prints command help. `agentvoice client` is the explicit pointer voice
frontend. The AgentVoice web UI at `https://agentvoice.localhost` presents one
persistent Agent transcript and accepts keyboard-submitted Agent input. Projected
voice handoffs remain visible there as Human messages with a microphone details button. The terminal
client owns native audio and WebRTC, and displays connection status and monochrome YOU/AGENT
buttons, plus PUSH TO TALK when the microphone is muted. `agentvoice phone`
instead opens a capability-bearing loopback page whose browser owns audio and
WebRTC. In both topologies the server owns exact conversation identity, thread
leases and its unmodified `codex app-server` child.

Persistent voice records retain exact workspace and thread identity checks and
remain available through server contracts, without a raw Voice lane in the web UI.
The web Agent composer uses the guarded host-side gateway;
native sockets and credentials never enter browser code.

The direction is vanilla Codex with configurable prompts and settings: the
client-and-server experience, including voice, is the baseline. Because AgentVoice
implements its own frontend, matching Codex can require the same explicit values
that Codex's client sends; simply omitting fields does not establish parity.
Ordinary launches resume the workspace's saved session, inherit native permissions, and
disable the generic voice startup snapshot to match the desktop client baseline.
Raw native settings remain available, with visible warnings for modes
that this frontend cannot implement; passthrough is not a claim of feature parity.

## Start here

From a prepared checkout (Bun dependencies and native audio already built), run
these in separate terminals:

```sh
# Terminal 1: restores marked native work, or waits unmarked; opens no audio
bun run /path/to/agentvoice/src/main.ts server

# Terminal 2: attaches media, creating an unmarked session if needed
bun run /path/to/agentvoice/src/main.ts client
```

On macOS, installation adds a native AgentVoice menu app and starts the default
server as a separate user LaunchAgent. The menu can show at login and reports the
LaunchAgent's job state without starting a call or probing Codex, authentication,
or audio. Quitting the menu leaves the server and any Android or terminal call
running. Run `agentvoice client` whenever you want terminal voice controls. For manual use, run
`agentvoice server`. See [macOS menu app](macos-app.md) for its build,
installation, and future native-UI boundary.
To choose an explicit workspace,
pass `--workspace /absolute/project` to both commands. Configuration, model,
voice, permission and role flags belong to
`agentvoice server`, for example `agentvoice server --fast`.
The `client` command also accepts `--device` and `--output-device` for
client-local audio. `client` and `phone` also accept `--connect <private-profile.json>`
instead of `--workspace` for authenticated WSS access to the desktop server.
Both clients use [client API v3](client-api.md); the server never opens audio.

On an Android phone, run the server and browser frontend in separate Termux
terminals:

```sh
# Terminal 1
agentvoice server

# Terminal 2: opens the phone browser; tap Start voice there
agentvoice phone
```

`phone` serves one ephemeral page on `127.0.0.1` and normally opens it with
`termux-open-url` or Android's activity manager. If neither launcher is present,
open the printed URL in a browser on the same phone. The browser asks for
microphone permission only after **Start voice** is tapped, then owns microphone
capture, response playback, codecs and the WebRTC peer. It provides microphone
and speaker mute plus hold-to-talk while persistently muted. The Termux process
continues to own the call controller, configuration, exact thread, transcripts,
gateway and stock Codex child. Use the desktop AgentVoice web UI for the Agent
transcript and keyboard-submitted Agent input; projected voice handoffs appear there.

The printed URL contains a per-process bearer capability. Do not share or
bookmark it. The listener accepts only exact-origin loopback requests and one
browser owner, and disappears when `phone` exits. It cannot bind to another
interface. By default the bridge calls the local Termux server. For the desktop
path, run `agentvoice phone --connect /absolute/private/desktop.json`: the Termux
bridge holds the device grant and connects over verified WSS/Tailscale; the page
and its media stay on the phone. No local Termux server is needed in that mode.
Codex, workspace, configuration and transcripts belong to the desktop server.
With `--connect`, the web Server selector can switch between Phone (Termux) and
Desktop (Tailscale). Switching detaches media from the prior server; Start voice
creates a fresh media attachment on the selected server. Each server retains its
own workspace session until it shuts down.
The bridge remains running between calls so switching/retrying needs no new
terminal command. Without `--connect`, the desktop option is disabled.
Hold to talk stays visible but disabled until the microphone is muted and voice
is connected; press and hold to talk, release to mute.
See [network setup and Android handoff](android-client-handoff.md).

The first [native Android app](../android/README.md) implements this authenticated
client API directly, with a Compose voice screen, QR enrollment, client-owned
WebRTC and foreground call ownership. It is a development build; on-device
native audio acceptance and release distribution remain pending.

To pair it, configure the dedicated private Tailscale WSS endpoint, then choose
**Pair phone…** in the macOS menu app or run `agentvoice network pair`. The
five-minute QR is a one-use enrollment capability. It registers a phone-owned
P-256 key; the resulting pairing has no expiry and remains until
`agentvoice network revoke <device-id>`. Enrollment and connection-proof checks
are auth-only and create no call. Before redemption the phone durably records
the exact pending tuple, allowing one exact recovery after a lost success
response without creating another device. A cold launch makes one connection
attempt to its saved server; failure waits for explicit Retry. Android Back and
Home leave an active foreground-service call running, with mute, return and hang
up controls in its ongoing notification; see
[Android call navigation](android-call-navigation.md). The older
`agentvoice network qr --name phone` command remains available for explicit
30-day bearer compatibility. Microphone permission is requested separately.
For an independently configured workspace server, pass `--workspace <dir>` to
`network configure`, `pair`, `list`, and `revoke`. Targeted pairing requires that
exact server to be running and never falls back to the default server; settings
and device records remain workspace-scoped. Pairing may also target the exact
workspace currently owned by the default server; its receipt omits `--workspace`
because that server retains the default network namespace.
The [adopted design profile](../android/design/shipping-profile.json) supplies shipping defaults;
the retained debug studio can audition and promote future designs, including
[Kenney CC0 switch sound families](../android/third-party/switch-sounds/README.md).
See [Design Studio icon credits](../android/third-party/icons/README.md) and
[Persona Halo attribution and asset provenance](../android/third-party/persona-halo.md)
for creator notices, code/runtime licenses and the external animation's license evidence.
The shared Agentwiki playbook explains this live design workflow for Android, web
and native desktop apps. Retrieve it with
`agentwiki get design-studio-playbook-for-android-web-and-native-apps`.

One server workspace session and one active frontend attachment are allowed per canonical workspace.
Local `agentvoice`, `agentvoice client` and `agentvoice phone` wait up to 30 seconds when the
previous frontend has disconnected but media is still detaching, displaying
“Detaching previous frontend…”. An active frontend still blocks a second owner. Waiting
does not reserve media, reconnect a disconnected client, or retry a refused request.
Network clients request admission once; busy/closing refusals require an explicit retry.
This requires a server running the same frontend observation contract; update
and restart an older server explicitly before using the updated client. A valid
marker restores and pins the server's workspace session at startup; without one,
the first accepted frontend creates it lazily. Closing
the terminal frontend, closing or navigating away from the phone page, or
terminating its owning process releases holds and closes client media. After the
native realtime stop is acknowledged, the server retains the controller, runtime,
Codex child, native work, gateway and endpoints without realtime speech.
A stop refusal or timeout reports an unknown outcome and blocks another frontend
until server restart while retaining native work. There are no
pointer-frontend keybindings, including quit; process signals still perform cleanup.
The default endpoint is independent of the current workspace generation. Without
`--workspace`, both commands use that endpoint from any launch directory.
Warnings and detailed failure reasons go to private service logs, or the terminal
when running the server manually.

```sh
agentvoice service status
agentvoice service load
agentvoice service unload
agentvoice service restart
agentvoice service remove
```

Restart ends any frontend media and the retained workspace session, then starts
a new waiting server that immediately restores a valid saved marker without
media. When invoked through that server, restart first returns a launchd helper
operation and private status path; the helper owns the unload and reload after
the initiating process exits. This full service boundary is separate from MCP/API
runtime restart, which keeps the controller and its workspace session. Removal unloads
only the owned LaunchAgent and removes its plist; workspace directories, logs,
configuration, command installation and native history remain. The TUI does not
automatically reconnect after server loss.

To connect Claude Code or MCP Inspector to one controller that is already
running, export its authenticated MCP client configuration:

```sh
agentvoice mcp-config --workspace ~/code/myapp
claude --mcp-config <(agentvoice mcp-config --workspace ~/code/myapp)
```

The command follows the fleet's `agentmux mcp-config` convention and prints one
`mcpServers` JSON object containing the live loopback URL and bearer header. It
defaults to the current directory, canonicalizes the workspace, and refuses an
ambiguous match; add `--thread <exact-id>` when several AgentVoice controllers
are running in that workspace. It remains usable when the voice runtime has
failed because discovery belongs to the foreground controller. The export does
not start AgentVoice, load its launch configuration, open media, or require
`--allow-full-access`.

The printed bearer token grants access to that controller until it exits. Keep
the JSON private and generate it again after a new launch. Claude Code and MCP
Inspector accept this JSON shape directly. Codex uses a different native MCP
configuration shape, so this output is not a Codex configuration file.

### Observe thread state

Print a current table of loaded threads, with children indented beneath their
parents, using `agentvoice threads`. It shows each thread's name (or native
agent nickname when unnamed), model, reasoning effort, turn activity and ID.
Idle threads remain visible alongside working threads; this is the owned
app-server's loaded inventory, not saved conversation history.

```sh
watch -n 1 agentvoice threads
agentvoice threads --workspace ~/code/myapp
```

Omitting `--workspace` selects the default server's active call from any directory.
An explicit workspace can select another server; `--thread <root-id>` resolves
multiple controllers for that workspace. No active call prints a short status
and exits successfully. Each invocation makes bounded read-only observations,
never opens audio or resumes a thread, and works with an already-running server.
`?` means a setting is unset or unavailable. Model/effort describe current thread
configuration, not per-turn execution telemetry. Settings and activity are read
separately; the command rejects runtime replacement during a read and marks
partial inventory instead of claiming an atomic snapshot. Missing parents and
unresolved ancestry remain visible. Output is plain text for use under `watch`.

`agentvoice event-socket --workspace ~/code/myapp` prints the separate read-only
Unix endpoint for a live controller. UIs subscribe with `event.subscribe`, then
read `state.get` for the current inventory and a sequence watermark. The endpoint
reports native thread state and runtime availability during a call, including
native subagents. The same endpoint also carries typed
`voice.*` items and transcript deltas as a live-only socket stream, without history
backfill. The controller automatically saves private workspace/thread JSONL; the
web server can read it live or after a call ends. An explicit `bun run voice:record
--workspace <dir> --out-dir <dir>` observer saves per-conversation JSONL for outside
tools. `state.get` remains lifecycle-only. See the
[event protocol](events.md) for prefix matching, snapshots, and limits, and
[events.schema.json](../events.schema.json) for the machine-readable event types.

Event protocol **3** also exposes `conversation.*` messages, tool activity,
plans/diffs, reasoning, usage and errors for the orchestrator and native subagents.
Independent UIs can request an exact live-item snapshot, replay a bounded window
of conversation events, and page native thread/turn/item history without resuming
threads or submitting work. Use `runtime.mainThreadId` and native parent links to
select a conversation family. See the [conversation contract](conversations.md)
for the methods and reconnect algorithm. Voice events remain live-only.
Event clients must match the event protocol. A new server workspace session creates
new event and control endpoints. Frontend detach preserves them; rediscover after
server restart.

### Native child results

Codex sends each terminal child's authoritative response to its exact native parent
through its own inter-agent queue. AgentVoice observes child lifecycle and history
for status, transcripts and AgentHUD export, but never converts those observations
into `turn/start`, steering, a wake-up, or a synthesized result. A queued result can
join an active native wait or the parent's next turn. See
[ADR 0103](adr/0103-retire-synthetic-subagent-lifecycle-steering.md) and the
[manager input audit](manager-input-audit.md).

### Watch Voice and Agent in a browser

```sh
npm --prefix web ci             # prepare the web dependencies once
agentvoice serve               # https://agentvoice.localhost, editable Vite dev
agentvoice serve --production  # optional, after bun run web:build
```

Two live transcripts sit side by side, labelled Voice and Agent, using the
AgentVoice-owned transcript components with Human / Agent labels. The view watches the
running default local server, follows the latest text, and reconnects through
call changes. An absent server and an idle server have clear empty states.
There are no surrounding controls, and closing the page leaves the call running.
The shared portless HTTPS proxy must already be running. See the [web guide](../web/README.md)
for setup, local-only observation, source provenance, verification and future
launchd ownership.

### Permissions

`--allow-full-access` is optional. Without it, AgentVoice leaves unset permission
fields to Codex and accepts native/configured sandbox and approval modes, including
named permission profiles. Native configuration and managed requirements still
apply. Workspace selection does **not** itself confine file access.

With the flag, AgentVoice explicitly requests `danger-full-access` and approval
policy `never`, overriding conflicting launch/request permission settings.
Unrelated raw native settings retain their normal precedence. The flag does not
bypass managed Codex requirements or grant connector consent.

The voice console shows an interaction notice for native approvals, tool questions
and MCP elicitations. Codex retains the pending request until native work is
cancelled or another supported Codex client answers it. AgentVoice neither
auto-approves nor auto-refuses these requests and maintains no approval queue.
Unsupported client-defined tools, auth callbacks, legacy requests and unknown
methods still receive a visible refusal or protocol error. Retired worker tools
remain retired. Restricted or missing permission reports do not stop voice or
prevent voice or web transcript observation.

Native protocol reference: [Codex approvals and connector interaction](https://learn.chatgpt.com/docs/app-server#approvals).

Requirements: Bun and stock Codex with the experimental realtime app-server
surface plus an authenticated Codex account. The terminal frontend additionally
requires built native duplex audio and a terminal with microphone permission;
headphones are recommended because that path has no echo cancellation. The phone
frontend requires a same-device browser with microphone and WebRTC support and
does not load native audio. It requests browser echo cancellation, noise
suppression and automatic gain control, whose effective behavior remains
browser/device policy. The original voice semantics were verified on Codex
0.147; run the native protocol probe before changing the supported runtime.

### WebRTC compatibility default

AgentVoice sends realtime **v3 by default** for WebRTC. Ordinary launches need
no personal configuration workaround. This is a documented frontend transport
choice that aligns with the inspected Codex desktop's newer client-owned-call
path; the owned Codex app-server remains unmodified. That desktop path is
conditional, so it does not establish every account's active version. See the
[client/server comparison](field-guide.md#default-comparison-audit).

On September 5, 2026, stock Codex 0.153.3's omitted-version WebRTC request was
rejected with `AVAS requires OpenAI-Alpha: quicksilver=v2.` Explicit v3 connected,
and the operator confirmed the launch works. In [Codex 0.153.3 source](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/realtime_conversation.rs),
v3 sends that required header; native WebRTC omission falls back to v1 and sends
`quicksilver=v1`. The header's `v2` is not protocol v2, which WebRTC rejects.

Explicit version overrides remain available; see [voice protocol](#native-voice-protocol).
Automatic retries pause after three consecutive short-lived failures. The frontend
shows FAILED and the server prints the cause. Use MCP/API redial to reconnect
voice, or runtime restart to reload code/configuration and resume the same thread.
Restart supports an optional caller-provided handoff prompt. These controls have
no TUI buttons or keybindings. Control protocol 9
exposes status, redial, restart, new session and voice selection with matching
MCP tools; see the [control API](api.md) and [orchestrator guide](../USAGE.md).

### Installation

Installation is deliberately separate. `bun run setup` checks prerequisites
and builds audio; `bun run native:build` rebuilds it. Both build without opening
an audio device. `scripts/install.sh --install` is the single editable installer;
`bun run cli:install` is an alias, and AgentStart's `install-agent-clis` delegates
to the same contract. Installation does not verify authentication or connect a
voice session; live voice compatibility is a separate check.

The installer requires Bun 1.3+, Node.js 24+ with npm, an executable stock Codex
(`CODEX_PATH` or PATH), a C11 compiler (Zig, clang or cc), and a clean checkout
with the AgentVoice GitHub origin. A full macOS install also requires the Swift
command-line tools, `iconutil`, and `codesign`. Codex is checked for presence, not
invoked; login and realtime compatibility are separate runtime prerequisites. It
runs `bun install --frozen-lockfile`, `npm --prefix web ci`, builds native audio to
a temporary file, and runs and verifies one production web build before it
atomically links `~/.local/bin/agentvoice`
directly to `src/main.ts` and records the commit in
`~/.local/state/agentvoice/deployed-sha` (`XDG_STATE_HOME` honored). The link preserves
caller cwd. On macOS, it also installs the signed native menu bundle at
`~/Applications/AgentVoice.app`, then installs
`~/Library/LaunchAgents/io.arthack.agentvoice.server.plist` and bootstraps the
waiting server in the logged-in user's GUI domain. The menu app and LaunchAgent
have independent login lifecycles: **Show menu at login** controls only the
menu app and is enabled by default on its first launch, while the LaunchAgent keeps
its existing RunAtLoad and KeepAlive policy. An explicit later opt-out is preserved.
Quitting or disabling the menu app never ends a call. Rerunning installation
restarts the server job and does end any active call. The job runs while logged
in; sleep suspends it. A manual default server must be stopped before installing,
since it owns the same socket.

Menu updates have a separate non-server scope:

```sh
scripts/install.sh --install --menu-only --quit-menu
```

`--menu-only` builds and installs only the native menu app. It does not prepare or
build the web reader, rebuild native audio, change the editable command or deployed
receipt, or operate the LaunchAgent, so the server and any call continue unchanged.
`--quit-menu` is the explicit permission to ask an outdated running owned menu app
to quit through its private control socket, wait boundedly, and reopen the new app
only if the old one was running. Without that flag, a changed running app is refused. The
flag adds no server action when used with a full install; full installation still
has its separately documented server restart.

The first upgrade from a menu version that predates this control socket needs one
last manual step: choose **Quit AgentVoice menu**, rerun the menu-only installer,
then open `~/Applications/AgentVoice.app`. The installer never falls back to a
signal, AppleScript, or a forced quit. A refused, busy, mismatched, or timed-out
request leaves the installed app untouched.

The plist pins absolute Bun and source entrypoint paths, uses the user's home
as launch cwd, and captures PATH plus configured XDG, CODEX_HOME, CODEX_PATH and
AGENTROLES_HOME environment entries. Unset CODEX_HOME stays unset. It copies no
credentials or arbitrary shell environment; settings come from the normal config
file. Relative file settings resolve from the service's launch cwd. Diagnostics
are private `default/service/stdout.log` and `stderr.log` files under AgentVoice
state. `service status` reports launchd state, not audio readiness. Background
microphone permission must be established for this launch context on first use.

TypeScript edits are live; native source changes need a rebuild.
This is an editable checkout, not an immutable deployment or rollback of dependencies.

Rerunning is safe: unrelated files/links, unsafe paths/receipts and dirty source
are refused. Frozen dependency, native build, web build, or production-index
verification failures preserve the prior production build and happen before
command/receipt publication and before an outdated running menu is asked to quit.
A link to another checkout requires its matching receipt; an existing
link into this checkout can be adopted or refreshed. The receipt records the last
installation, not the current state of subsequent edits. Build failures leave the
command/receipt untouched; a failed compile preserves the prior native library.
The retained `.install-lock` is a regular private file whose kernel lock is
released when an installer exits or is killed; do not remove it between runs. A
directory at that path is a legacy interrupted-lock condition: inspect process
state before removing that directory once, then rerun. A full install launched
from the managed AgentVoice server is accepted by a separate launchd helper and
continues after the initiating server exits; the printed private status receipt
distinguishes acceptance, execution, success and recoverable failure.
If another command shadows the link on PATH, installation warns without deleting it.

For disposable tests or alternate destinations, set absolute
`AGENTVOICE_INSTALL_BIN_DIR`, `AGENTVOICE_INSTALL_STATE_DIR`, and on macOS
`AGENTVOICE_INSTALL_APP_DIR` paths. Pass `--command-only` to avoid building or
installing the menu app and touching the user's LaunchAgent; command-only still
prepares frozen web dependencies and verifies the production reader build needed
by `agentvoice serve --production`. The bin and state
overrides move only command publication and its receipt; service state follows
XDG_STATE_HOME.
Non-macOS installations publish the command only. No prompts, skills, credentials,
Codex configuration or shell profiles are changed, and installation never starts
the TUI or a voice call. An unrelated or edited plist is refused. A service failure
is reported separately if command publication already succeeded.

For an ARM64 Android/Termux standalone executable, cross-compile from a prepared
checkout with a Bun release that supports the Android target:

```sh
bun run android:build
# output: dist/agentvoice-android-arm64
```

To converge that binary on an already prepared Termux phone through an existing
SSH target:

```sh
scripts/install-android --install --host smolbird
```

This explicit installer requires a clean checkout, verifies Android ARM64 plus
the existing `codex` and `termux-open-url` commands, and publishes the executable
as private `~/.local/bin/agentvoice` with an ownership-correlated receipt. It can
adopt an unreceipted binary only when its SHA-256 exactly matches the new build
or the one explicitly pinned pre-installer phone build. It is not part of
desktop or unattended installation.

The standalone binary embeds AgentVoice and Bun, not Codex credentials,
configuration or history. Install it as an executable inside Termux and keep the
Termux `codex` command on PATH (or set `CODEX_PATH`). The `phone` media path does
not require `bun run native:build`; native `client` calls still do. The build-only
command does not copy to a device; neither command alters Android permissions,
logs in to Codex, starts a service or call, or opens media.

## Conversations and workspaces

One canonical workspace per call: `--workspace` > an explicit
`orchestrator.workspace` in the config > the current default workspace directory.
Relative explicit paths resolve from launch cwd; relative additional runtime
roots resolve from the selected workspace. Explicit symlink paths canonicalize
to the same directory.

The workspace base is `$XDG_STATE_HOME/agentvoice/default/workspaces/`, falling
back to `~/.local/state/agentvoice/default/workspaces/`. The newest generation
name selects the current directory: `YYYY-MM-DDTHH-mm-ss.sssZ-<lowercase-UUID>`.
Ordering uses names, never directory modification times. Only names matching that
format participate; the selected directory must be user-owned, not writable by
other users, and not a symlink. The workspace base is private (mode 0700).
The initial empty generation is created atomically using the base's creation time
and a zero UUID, so concurrent initializers agree. Other namespaces are reserved
for future named voice agents; there is no named-agent selector yet.

The default server selects and pins the current generation at launch when it has
a valid marker. Without a marker it selects once when its first frontend creates
the lazy workspace session. A later generation takes effect only at the next
applicable server/session boundary; old directories and native history remain. There is no reset, deletion or transcript
cleanup operation. Native context policy is unchanged.

An explicit CLI workspace selects a separate workspace socket; pass the same
`--workspace` to its server and frontend. A file-configured workspace pins the
default server's calls while retaining the default endpoint. Workspace settings
are selected at server startup; restart the service to change that selection.
Read-only discovery commands accept `--workspace <directory>`; their omitted
workspace remains the invoking directory.

Each workspace keeps its current Codex thread ID in `.agentvoice-session`, a
private plain-text file containing the ID and a newline. Every server workspace
session resumes that exact thread with `thread/read` and `thread/resume`, including after client or
server restarts. There is no latest-history lookup. Native identity must still
match this canonical workspace and an AgentVoice main thread.

If the marker is absent, the next frontend-created workspace session creates a new
thread and saves its ID before readiness. Delete the marker only while the server
is stopped or otherwise has no workspace session to select a new thread at the
next server or frontend start. Deleting it
during a retained session does not interrupt that session, and frontend reattachment
does not reread it; ordinary runtime restart still retains its active thread. An invalid or unresumable marker reports an
error and stays intact. Native history, transcripts and workspace files remain
untouched. Ephemeral threads are incompatible with persistent workspace sessions.

For an immediate new session in a retained workspace session, use the `agentvoice_new_session` MCP
tool or `agentvoice.new_session` control API. It preflights a replacement, stops
the old runtime and work, removes the marker, then creates and saves a new thread
and reconnects voice when a frontend is attached. The workspace, controller and mute preferences remain;
transcripts stay separate. See [control API](api.md).

`--resume`, `--continue`, `--fresh` and `--no-continue` are retired and report
marker guidance. Existing launch scripts using those flags must remove them.
To select an existing session explicitly, put its exact thread ID in the marker
while no call owns the workspace; native ownership checks still apply.

Each voice connection starts without AgentVoice reading or injecting earlier
speech or adding its own reconnect instruction. Native saved conversation history remains intact.

AgentVoice defaults the native startup snapshot (including Recent Work) to off
on every call, including renewal, matching the inspected desktop client. The
app-server instead defaults omission to on; see [ADR 0029](adr/0029-desktop-startup-context.md).
Set `voice.include-startup-context` to `true` to request the snapshot explicitly
in your selected `server.json`. Explicit raw `voice.extra.initialItems` also remain supported,
including `[]` and `null`; populated initial items require effective realtime v3.
Prompt files and other native config overrides keep their existing behavior.

Automatic spoken-history replay has been removed. If your config contains
`voice.replay-spoken-history`, remove that key, even if its value is `false`.
It errors at load with removal guidance, as does the older `voice.quiet-resume`
key. AgentVoice does not migrate or delete your configuration or saved history.
See [ADR 0017](adr/0017-remove-spoken-history-replay.md) for the decision.

A valid marker begins the server's workspace session at launch; without one, the
first frontend connection begins it and creates the marker. Workspace and thread
kernel locks remain held until server shutdown. Later frontend attachments use
that retained identity.

Closing a frontend stops client media and, after acknowledged native stop,
realtime voice. Native work continues in the retained Codex child. Explicit
runtime restart or `new_session` interrupts the work those operations replace;
server shutdown closes all owned work. Native saved history remains available to
a later server session; ephemeral/unpersisted threads cannot be resumed.
Workspace selection is not a memory or security sandbox.

## Features and controls

- In the pointer TUI, click YOU to toggle microphone mute and AGENT to toggle
  speaker mute. The phone page exposes equivalent labeled buttons.
- While the microphone is muted, hold PUSH TO TALK to speak. Releasing restores
  mute; terminal blur, page loss and frontend disconnect cancel the hold.
- Buttons use white and grey only. Muted channels are greyed out. There are no
  animations, meters, timers, extra status rows, modal or application keybindings.
- The top line shows only the connection phase. LIVE confirms the media link,
  not that native work completed or speech was heard.
- Terminal full-duplex audio uses client-owned miniaudio, Opus and WebRTC.
  Phone audio and WebRTC stay in the browser; only bounded control and SDP
  signaling cross the private frontend path. Automatic renewal maintains either
  connection without changing its conversation or configuration.
- Server settings and prompt files load once per runtime generation. Runtime
  restart, `new_session`, or a later server lifetime reloads file contents;
  frontend reattachment does not. Changing launch flags or the workspace requires a new server.

Warnings appear in the server terminal. With `--debug`, private per-workspace-session logs
also capture protocol/media details. Native item deltas remain available through
the read-only event socket; the frontend does not display them.

Workspace-session startup validates prompts and protocol before opening media. A terminal client
also validates native device readiness before its WebRTC offer; a phone call asks
the browser to prepare its peer and never loads the native duplex library. Media
failure closes client media; native conversation creation or resume may already
have happened and the retained runtime may require explicit recovery.

## Configuration and prompts

Workspace-owned SQLite roles are available through explicit
[`agentvoice role eject`](workspace-roles.md). Ejection captures settings,
prompts, MCP definitions and skill assets. Bound workspaces load database
revisions instead of the source files below. `role export` / `import` create
independent copies; fenced `role adopt` captures an updated directory-role asset
bundle while preserving saved settings; `role voice` saves a voice, and MCP/API
`agentvoice_voice_set` can save and reconnect voice while preserving the working
agent and media attachment.
Unbound workspaces retain the file behavior below.

Keep `~/.config/agentvoice/server.json` (or
`$XDG_CONFIG_HOME/agentvoice/server.json`). Its legacy filename does **not**
imply a background server. Use `--config <path>` for another file.

`server.json.example` is a no-op example. The generated
[JSON schema](../server.schema.json) documents every key; the
[field guide](field-guide.md) maps the current surface and remaining cuts.

Common launch options:

```sh
agentvoice server --workspace ~/code/myapp --model <model-id> --effort high
agentvoice server --fast
agentvoice server --no-fast
agentvoice server --voice <voice-name>
agentvoice client --device 1 --output-device 2
agentvoice server --config ./voice-settings.json --debug
agentvoice server --role researcher
```

Named CLI options beat the same named file settings. Raw native overrides merge
later: `orchestrator.extra.model` beats `--model`, an explicit
`orchestrator.config.model_reasoning_effort` beats `--effort`, and
`voice.extra.voice` beats `--voice`. `orchestrator.extra.config` replaces the
assembled request config as a whole. Fast flags and `--allow-full-access` are
explicit exceptions: they win over raw settings for their respective controls. Unset settings stay off the wire
except documented application defaults such as WebRTC v3. Evaluate these against
both client selection and server resolution; server omission alone does not
define vanilla Codex.

### Native startup settings

`--config` selects AgentVoice's JSON file. Repeatable `-c` / `--codex-config`
instead supplies **native Codex startup configuration**, just like Codex's own
`-c key=value`. No entries are supplied by default. With `--allow-full-access`,
explicit native permission overrides follow the user entries so the flag wins.

```sh
agentvoice server -c model_reasoning_effort=high
agentvoice server --codex-config 'shell_environment_policy.include_only=["PATH","HOME"]'
```

The equivalent opt-in JSON setting is an ordered array of native strings:

```json
{
  "codex-config": [
    "model_reasoning_effort=high",
    "shell_environment_policy.include_only=[\"PATH\",\"HOME\"]"
  ]
}
```

File entries come first, followed by CLI entries in the order you typed them.
Codex processes them in order; later assignments win (including replacement of
whole tables). An empty array adds nothing; it does not clear inherited native
configuration. Values use **TOML, not JSON**; Codex falls back to a string when
TOML parsing fails. Empty strings, arrays, booleans, equals signs and whitespace
are passed intact. Each entry is one native argument, never evaluated by a shell.
Paths inside native values follow Codex's rules; AgentVoice does not expand them
or make them relative to its JSON file. Prefer explicit absolute paths when unsure.
Avoid credentials in CLI values: shell history/process listings may expose them.

There are three distinct configuration points:

| Setting | Applied when | Lifetime |
| --- | --- | --- |
| `codex-config` / `-c` | Owned Codex child starts | Entire launch, including automatic renewal |
| `orchestrator.config` / `orchestrator.extra` | Conversation starts or resumes | Native thread configuration/history rules |
| `voice.extra` | Realtime voice session starts | Each voice start/renewal |

Startup entries override native config files, but they are not forced over later
conversation settings. A stock 0.153.3 offline probe confirmed the new-thread
model order: native file < ordered startup entries < request `config.model` <
explicit thread `model` (AgentVoice `--model` / `orchestrator.model`, then raw
`extra.model`). This is not a universal precedence promise for every native field;
managed requirements still apply and some native config keys override voice RPC
fields. Continue/resume can retain saved model settings; use `--model` to explicitly
change a resumed conversation's model (unless a raw field overrides it).
In Codex 0.153.3, an explicit reasoning-effort request also prevents restoring the
saved model/provider: supply `--model` too when you want to keep a specific model.
Known start-only fields, including raw `dynamicTools`, `ephemeral` and
`historyMode`, are stripped from resume requests; omitting them does not remove
metadata already saved in native history. `--fast`/`--no-fast` retain their explicit
launch-tier precedence.

All AgentVoice settings, including `voice.name`, and prompt-file contents are
read during runtime preflight and cached for that generation. Frontend detach
and reattachment preserve them. Explicit runtime restart, `new_session`, or the
next server workspace session reloads files using the server's launch arguments
and pinned canonical workspace.

### Native voice protocol

AgentVoice defaults the final WebRTC request to `version: "v3"` when the version
is unset. This restores service compatibility, rather than inferring a default
from another Codex UI. The choice applies on start, continue, explicit resume,
automatic renewal. No configuration file is created or edited.

Named `voice.version` overrides it, and raw `voice.extra.version` wins last.
Explicit v1 still passes through, although the service tested here rejects it.
Raw `voice.extra.version: null` requests Codex's native fallback (WebRTC v1 in
0.153.3), including its compatibility risk. Explicit invalid values are not
silently repaired. Alternate raw transports receive no v3 default; this TUI
still implements only WebRTC media.

Codex chooses the speech model: with v3, its 0.153.3 fallback is
`gpt-live-1-codex`, after explicit voice-model and native configuration overrides.
AgentVoice supplies no model name. Sending an explicit protocol also restores
Codex's configured realtime voice selection, which omitted-version WebRTC
ignores. `--voice` / `voice.name` still overrides the voice name. Current v1/v3
share a voice-name family. Protocol selection does not select the working model,
reasoning or Fast tier, or change startup-context/tail-flush settings.

Nonempty `voice.extra.initialItems` require effective v3, which the normal WebRTC
default satisfies. Conflicting explicit protocols and WebRTC v2 fail before Codex
starts. Checks use the final merged request. Items are never silently dropped.

For the related audit of prompts, context, handoffs and frontend responsibilities,
see the [default comparison audit](field-guide.md#default-comparison-audit).

### Supported behavior and raw experiments

Native Codex tools, subagents and native voice handoffs work through app-server.
`client-managed-handoffs: true` instead expects client append calls that AgentVoice
does not implement. Nonempty `orchestrator.extra.dynamicTools` advertises tools
on new conversations without adding handlers; those calls fail. Overriding
`voice.extra.transport` or selecting non-audio `outputModality` can break this
TUI's generated WebRTC offer/audio path. These modes remain raw passthrough for
experiments and produce a visible launch warning. Use the omitted settings for
the supported baseline. Unknown or misspelled native keys can still be ignored
by Codex; AgentVoice does not validate every upstream option.

### Native Fast mode

`--fast` requests the working Codex model's advertised Fast tier: the same model
and reasoning settings, faster processing at higher usage/cost. It does not
change the realtime speech model, speech speed, prompts or voice context.
`--no-fast` explicitly requests standard processing. The flags conflict with
each other; omitting both preserves existing AgentVoice/native tier settings.

These are launch overrides, including for continued conversations.
They beat `orchestrator.service-tier`, native config overrides
and `orchestrator.extra.serviceTier`. Raw configuration remains unchanged when
neither flag is supplied. Fast enables only the thread-local native feature
gate; AgentVoice never saves this choice to global Codex configuration.
Native thread history/settings still follow Codex's own persistence rules.

Fast checks the current child's paginated model catalog, including hidden models.
Unknown/unsupported models or unavailable
capability information produce an error, not a model substitution or silent
fallback. A per-thread provider override differing from the child's catalog
provider cannot be verified; configure that provider natively or omit `--fast`.
If an older Codex lacks service-tier catalog metadata, update it or use the raw
passthrough without the flag. Codex/account/provider restrictions still apply.

Native settings metadata distinguishes requested and reported tiers. The minimal
frontend displays only connection phase, with no tier indicator. See
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).

### Prompt override files

Prompt overrides are files with fixed names in the directory of the selected
config file (`~/.config/agentvoice/` by default, or beside `--config`), **not**
the workspace. Each name is exactly one native Codex control; there is no
AgentVoice-shaped overlay. A present file loads, an absent file sends nothing,
and an empty file sends empty text. Without selected files or a role, AgentVoice
supplies no custom prompt text.

| File | Agent | Native control |
| --- | --- | --- |
| `VOICE_AGENT_SYSTEM_PROMPT.md` | voice | Realtime `prompt`: replaces Codex's built-in voice prompt |
| `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` | voice | Text Codex renders after its built-in voice prompt, through the startup-context slot (below) |
| `VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md` | orchestrator | Thread `baseInstructions`: replaces the entire base prompt (visible warning; `personality` no longer applies) |
| `VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md` | orchestrator | Thread `developerInstructions`: Codex's developer message after the base prompt |
| `VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md` | orchestrator | Native `features.multi_agent_v2.multi_agent_mode_hint_text`: replaces delegation-mode guidance and enables V2 |
| `VOICE_ORCHESTRATOR_SESSION_START.md` | orchestrator | `realtimeStartInstructions`: replaces the built-in developer message sent when a voice session starts |
| `VOICE_ORCHESTRATOR_SESSION_END.md` | orchestrator | `realtimeEndInstructions`: same, when a voice session ends |

An override and an append for the same agent are one choice: both
`VOICE_AGENT_*` files, or both `VOICE_ORCHESTRATOR_*_SYSTEM_PROMPT` files, present
at once is a launch error. The voice append is literal concatenation: Codex has no
append field, but when startup context is enabled it renders
`prompt`, a blank line, then the `experimental_realtime_ws_startup_context`
config text in place of its Recent Work snapshot. AgentVoice sends that text and
`includeStartupContext: true` for the file, so the slot has one owner: an
explicit `voice.include-startup-context`, a raw `includeStartupContext` override,
an `orchestrator.config` or `orchestrator.extra.config` entry for that key, or a
`codex-config` entry for it conflicts with the file and fails at launch. The
orchestrator append is a developer message, not a suffix, because its default
prompt is per model and partly remote; Codex's own append channel is used as is.

The multi-agent mode file owns its native request-config slot. Duplicate mode
settings, disabled V2, or raw `extra.config` that drops or changes the file's
mode fail before child startup. Unrelated V2 settings are preserved, with either
native dotted-key or nested-table configuration. The request overrides native
startup/config defaults; managed native requirements still apply. An empty file
sends empty text, which suppresses the native mode message; absence sends no
mode or feature override. Codex 0.153.4 limits custom mode text to 400 estimated
tokens. Contents load once per runtime generation.

A present name must load: an unreadable file, a directory or a broken link fails
before Codex starts, even if a raw field would override the contents. Symlinks to
regular files work. Contents are cached by the active runtime across frontend
attachments, then reread by explicit runtime replacement, `new_session`, or a
later server lifetime. Session-boundary instructions and voice prompts ride every realtime start,
including automatic renewal. Explicit voice context items use raw `voice.extra.initialItems`,
not prompt files. AgentVoice never automatically seeds saved speech
([ADR 0074](adr/0074-fail-closed-voice-history.md)).

The former names (`VOICE.md`, `ORCHESTRATOR.md`, `ORCHESTRATOR_BASE.md`,
`ORCHESTRATOR_SESSION_START.md`, `ORCHESTRATOR_SESSION_END.md`,
`VOICE_SEED_DEVELOPER.md`, `VOICE_SEED_USER.md`, `VOICE_SEED_ASSISTANT.md`) and
the retired `prompt-files` config section no longer load anything: a leftover file
produces a visible warning without being read, and the config key is an unknown
option. Rename or remove them yourself; nothing is migrated or deleted. Removing
an override does not erase earlier instructions/messages from a resumed native
conversation; use explicit `new_session`, or stop the server and remove
`.agentvoice-session`, when testing the baseline. Native global and workspace instructions, skills, MCPs and hooks still
apply, even to new conversations. AgentVoice does not automatically enable AgentStart skills
or isolate native state; a [role](#roles) adds its own skills and MCP servers to
this launch without changing what other Codex processes see.

The two request escape hatches are `orchestrator.extra` and `voice.extra`;
`orchestrator.config` carries native Codex config overrides. Extra values
usually win, but cannot replace conversation IDs, the selected workspace, or an
explicit launch Fast/standard selection; conflicting permission selectors error.
Unknown upstream fields may be silently ignored. Transport/output overrides
can break the media path; not every upstream feature has a matching TUI.

Inline prompt values work through these same native escape hatches:

```json
{
  "orchestrator": { "extra": { "developerInstructions": "Your explicit instructions." } },
  "voice": { "extra": { "prompt": "Your explicit voice prompt." } }
}
```

Raw fields win over file contents, including explicit empty/null values; omit a
field to restore native resolution. Native config can itself override request
prompts, so removing AgentVoice overrides is not a global Codex prompt reset.

### Roles

A role is a directory that changes what this launch's agents can do without
touching global Codex or AgentVoice state: skills, MCP servers, and prompt
replacements or appends. The format is shared with the `agentroles` CLI, which
delivers the same directory to Claude Code and the Codex CLI by command-line
arguments. AgentVoice reads it natively because only its own process can
register skill roots with the Codex child it owns.

```sh
agentvoice server --role researcher      # ~/.config/agentroles/researcher
agentvoice server --role ./roles/researcher
```

`--role` takes a name under `$AGENTROLES_HOME` (default `~/.config/agentroles`)
or a directory path. The `role` key in `server.json` is the file-level default;
`--role` overrides it. Names use letters, digits, `_` and `-` only.

AgentStart owns the manager (formerly default) and worker role definitions,
including their prompts and independent MCP inventories. After its resource sync:

```sh
agentvoice server --role ~/.local/share/agentstart/resources/roles/manager
agentvoice server --role ~/.local/share/agentstart/resources/roles/worker
```

No role is selected when `--role` and the config's `role` key are absent.
See [external working roles](../roles/README.md) and
[ADR 0051](adr/0051-agentstart-owns-working-roles.md) for ownership.
AgentVoice applies the selected directory through these generic conventions:

| Role file | Effect in AgentVoice |
| --- | --- |
| `SYSTEM_PROMPT.md` / `APPEND_SYSTEM_PROMPT.md` | Orchestrator `baseInstructions` / `developerInstructions`: the general role prompt every harness receives |
| `VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md` / `VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md` | Voice-specific stand-ins for the general file of the same kind, used by AgentVoice only |
| `VOICE_AGENT_SYSTEM_PROMPT.md` / `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` | Voice agent prompt, as in the prompt override files above |
| `VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md` | Native multi-agent mode text and V2 enablement on thread start/resume |
| `VOICE_ORCHESTRATOR_SESSION_START.md` / `_END.md` | Realtime start/end instructions, as above |
| `skills/<name>/SKILL.md` | Registered with the owned child through `skills/extraRoots/set` right after `initialize`; no other Codex process sees them, and nothing is written under CODEX_HOME |
| `mcp.json` | Claude Code's `.mcp.json` shape (`{"mcpServers": {...}}`), translated to Codex fields (`headers` becomes `http_headers`, `type` is dropped, `sse` is rejected) and sent as per-thread `mcp_servers` config on start and resume |

With a role active, the config directory's prompt files are ignored with a
visible notice, and after voice-specific stand-ins are applied the orchestrator
must end up with either a replacement or an append, never both. Role MCP server
names must not collide with `orchestrator.config.mcp_servers`, and a raw
`orchestrator.extra.config` that drops them is an error. A missing role
directory, an unreadable file, or a Codex child that rejects the skill-root
request fails before audio opens. Roles load once per runtime generation like every other
setting; Codex itself watches the skills root, so skill edits apply to later
turns. Verified on stock Codex 0.153.4 on September 5, 2026 with
`bun run app-server:probe`, which registers a disposable root and reads it back.

### Native voice context: baseline first

AgentVoice sends `includeStartupContext: false` by default on ordinary launch,
continue, explicit resume and automatic renewal. This matches the inspected desktop
client's startup baseline; omitting the field would select the app-server default
of true. The desktop also has optional continuity machinery that this choice does
not copy. See [ADR 0029](adr/0029-desktop-startup-context.md) for exact bundled
JavaScript evidence and the scope of this decision. Tail flush and startup-text
overrides remain unset. Saved speech is never automatically supplied as realtime input.
The shipped `server.json.example` remains an unconfigured example.

A saved conversation is not the same as a voice call: subsequent calls may
resume the same conversation using the workspace marker. Codex can give
each call a startup snapshot and can deliver leftover speech to the working
agent when a call ends. AgentVoice keeps saved speech outside automatic realtime input on redial,
reconnect and server resume. Read-only transcripts retain observed agreements; context already present
in native root history remains; the speech front may need fresh input to consult the working
agent. Raw `voice.extra.initialItems` remains authoritative, including `[]`/`null`.
The removed restoration could cause duplicate work despite historical/wait framing;
see [ADR 0074](adr/0074-fail-closed-voice-history.md).

The following are optional overrides. Merge the setting into your config and relaunch;
these controls do not hot reload.

Explicitly request Codex's startup snapshot, including Recent Work. Codex 0.153.4 bundles
that with current working-thread context and a machine/workspace map; there is
no native Recent Work-only switch. This can inform even a new-session call
about earlier conversations, while its working thread is still newly created:

```json
{ "voice": { "include-startup-context": true } }
```

Allow Codex to send leftover speech to the working agent at call end:

```json
{ "voice": { "flush-transcript-tail-on-session-end": true } }
```

Replace the generated startup snapshot with your own text:

```json
{
  "voice": { "include-startup-context": true },
  "orchestrator": {
    "config": { "experimental_realtime_ws_startup_context": "Your startup context." }
  }
}
```

`VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` is this same pair, written for you, so it
cannot be combined with either setting. An explicit empty string for that
override suppresses its text; it is not the same as leaving the key out.
`include-startup-context: false` skips both the generated snapshot and any
override. Neither control erases the working agent's
history or prevents later recall through delegation. A native snapshot may
include other threads, so workspace-local conversation selection is not memory
isolation.

Tail flush is independent of startup context: enabling it can start work at
hangup. Quitting AgentVoice still stops its child and does not wait for that work
to finish. Disabling tail flush does not suppress normal in-call delegations.

Removing `include-startup-context` restores AgentVoice's false default; raw
`voice.extra.includeStartupContext: null` requests native server resolution
(currently true). Other
unset native controls still defer to Codex; `false` and `""` are explicit values.
`voice.extra` wins over
the named voice controls, and `orchestrator.extra.config` replaces
`orchestrator.config` as a whole, so remove conflicting raw overrides too.

## Native work, no custom worker layer

Codex owns the voice-to-working-agent handoff, tools, subagents, native events and
authoritative child-result return. AgentVoice keeps lifecycle observation read-only.
AgentVoice does not add worker execution tools or archive/delete completed work. An explicit MCP/API restart
handoff is submitted once through native `turn/start` after exact resume and live media.
It generates no worker-specific instructions; optional operator prompt overrides
still pass through.

`orchestrator.dispatch` and `orchestrator.dispatch-reports` are retired: remove
both keys from old configuration, even when set to `false`. Existing conversation
history is untouched. Codex can retain old dynamic tool definitions on resume;
calls to `dispatch_worker`, `check_workers` or `cancel_worker` now receive an
immediate failed tool result and a visible retirement notice in the server terminal. An explicit
new session starts without the old definitions; there is no automatic switch,
history rewrite or transcript copying.

The native `orchestrator.extra.dynamicTools` escape hatch still passes through
explicit metadata, but AgentVoice implements no client-defined tools. Unknown
tool requests receive a protocol error. This does not disable Codex's own tools.

## Native authentication

Log in with stock `codex login` before launching AgentVoice. The owned child
inherits your environment, including `CODEX_HOME`; if unset, Codex resolves its
own default home (`~/.codex`). Codex owns credential storage and refresh—AgentVoice
does not read credentials, launch login, select accounts or replace its child
in response to quota updates. Native credential-store settings remain native.
See [Codex authentication](https://learn.chatgpt.com/docs/auth#credential-storage).

To deliberately use another existing native home, pass the same environment to
both commands (examples only; nothing is configured automatically):

```sh
CODEX_HOME=/absolute/path/to/codex-home codex login
CODEX_HOME=/absolute/path/to/codex-home agentvoice server --allow-full-access
```

Use the same stock Codex executable for login and AgentVoice's `--codex` option
if your shell's `codex` is a custom wrapper. Changing `CODEX_HOME` also changes
the native configuration/history available for workspace-local continuation.
AgentVoice does not merge or migrate those stores.

### Migrating former account profiles

The entire `accounts` config section and `agentvoice accounts` commands are
retired. Remove the section from your chosen `server.json`, even if it only says
`balance: false` or is empty; launch otherwise errors before starting Codex/audio.
The old account-profile/inference probe is also removed.

Existing `~/.local/state/agentvoice/accounts/<slug>` directories (or the XDG
equivalent), credentials and symlinks are preserved, never reconciled or deleted.
To keep using one intentionally, set `CODEX_HOME` to its existing absolute path.
Its existing shared-state links still apply; AgentVoice no longer maintains them.
Without that explicit selection, no old profile is chosen automatically. Do not
copy authentication grants between stores; use native login if needed. No global
configuration, services or other account tools are changed by this removal.

## State and migration

Native conversation history stays in Codex's own store. AgentVoice state under
`$XDG_STATE_HOME/agentvoice` (default `~/.local/state/agentvoice`) contains
`default/workspaces/` generations, `default/service/` logs,
`frontend/` default and explicit-workspace sockets, `thread-locks/`, private workspace-session controller
discovery records under `control/`, and
`runs/<time>-<pid>.log` with `--debug`. Every runtime also creates a
private `native-ws-*` directory holding the owned listener token; normal runtime
shutdown removes it. Lock files are inert after exit; the
kernel owns their lifetime. Discovery records contain the loopback bearer
capability, use private directory and file modes, and are removed on normal
controller shutdown. `mcp-config` validates the live control socket and ignores
stale crash residue rather than choosing it or deleting it.
Debug logs may contain prompts, transcripts and protocol details—keep them private.
They also record the selected workspace and conversation ID.

`resident`, `remote` and `console` commands, and the `remote` config section,
fail with a retirement message. `server` now names the waiting local server; it
does not restore the retired remote/resident implementation. Remove a retired `remote` section from
your chosen config before launching. Other unknown retired keys are rejected
by strict config validation.

The explicit installer manages the native menu bundle and only its
`io.arthack.agentvoice.server` LaunchAgent. Normal launches never install apps or
services, migrate history or clean private state.
Previously installed legacy LaunchAgents, old logs, pairings,
`thread.json` and `workers.json` are untouched and unused by this source.
An old running service will not honor the new per-thread lock: stop/migrate it
explicitly before sharing its conversation with this version. This change does
not control those old processes.

## Development

### Waveform gallery

`bun run waveforms` opens a standalone OpenTUI gallery of twelve animated,
synthetic waveform studies. It uses fxnk's fixed monochrome dark/light palettes,
fine Braille traces and half-block fields. Signals are generated locally; the
gallery opens no microphone, speaker, voice call, or Codex child.

Click a study or select it with arrows / `h` `j` `k` `l`, then press Enter to
expand it. Space pauses, `[` / `]` adjust speed, `-` / `+` adjust amplitude,
`,` / `.` adjust frequency, and `0` resets parameters and time. Escape returns
to the gallery; `q` or Ctrl+C quits. Click **Commands**, press Ctrl+K or `?` to
search all actions and studies. All controls accept clicks; the wheel adjusts
a parameter under the pointer, or moves between studies elsewhere. Smaller
terminals show fewer previews; selection moves through all twelve.
In shallow expanded views, parameter controls move into **Commands** to leave
room for the waveform; their keyboard shortcuts remain available.

Theme selection follows `FX_THEME=dark|light`, a bounded terminal background
query, `COLORFGBG`, then dark. Live terminal theme changes swap the complete
fixed palette. Waveform trails use the five grayscale steps; they never sample
the host palette. Animation stops while paused, unfocused, or using commands.

### Persona lab

`bun run personas` opens eight audio-reactive variations alongside the original
`bun run waveforms` experiments. The standalone lab uses the same fxnk style and
OpenTUI renderer, with explicit `idle`, `listening`, `thinking`, `speaking`, and
`asleep` states inspired by [AI Elements Persona](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/persona.tsx).
Waveform waterfall, phosphor scope, braided harmonics, FM ribbon, phase rose,
radial pulses, standing waves, and Lissajous loops each respond to speech in a
different way. Speech loudness, sixteen frequency bands, and attack detection drive
their geometry; conversation state is always supplied explicitly. Continuous
curves follow a smoothed speech envelope: syllables rise promptly, short gaps
hold briefly, and phrases ease back to quiet. Frequency bands shape timbre
gradually, and radial pulses are spaced to avoid flickering on every consonant.

```sh
bun run personas
bun run personas --variant rose --view sizes
bun run personas --say
bun run personas --wav speech.wav --state speaking
bun run personas --mic
```

The default demo analyzes two bundled, locally synthesized speech clips with
an authored conversation timeline. Demo and WAV replay are **silent**: the PCM
drives the visuals without opening a speaker. WAV input supports mono/stereo
PCM16 and float32 at 8–96 kHz, bounded to 24 MiB and 20 ms–120 seconds. The lab
does not start a voice call, connect to the server, or run Codex.

`--say` generates the demo utterances with macOS `say`, then plays their PCM
with `afplay` while analyzing the same samples. Playback follows the conversation
cycle and supports pause, seek, and replay. It stops on terminal blur, opening
commands, and exit; returning to an active view resumes it. Q also cancels speech
preparation. Generated files are private and removed on exit, and owned speech
processes are stopped and reaped. The visual clock follows elapsed playback time;
player and audio-device startup can add a small audible offset.

`--mic` explicitly opens the existing native duplex device for microphone
input (requires `bun run native:build` and OS microphone permission). Its
playback side receives no samples. Capture stops on pause, terminal blur,
opening commands, and exit; returning to an active view resumes it. Nothing
is recorded. An unavailable source is reported visibly and is not retried.

Arrows or `h/j/k/l` select a variation; Enter opens its voice card. `v` compares
the same persona at **12 × 4**, **24 × 1**, and pane size. `1`–`5` select states;
`a` restores the demo conversation cycle. Space pauses, `[` / `]` seek by two
seconds, and `r` replays. Escape returns to the gallery; `q` or Ctrl+C quits.
Every full-view control accepts clicks. Ctrl+K or `?` opens searchable commands
when controls are folded away. Tiny panes keep a compact visual on screen;
click the visual or use arrows to cycle variations.

The visual itself is reusable independently of the lab:

```ts
import { AudioAnalyzer, Persona } from "./scripts/personas/persona.ts";

const input = new AudioAnalyzer(48_000);
const output = new AudioAnalyzer(48_000);
const persona = new Persona(renderer, {
  state: "listening",
  variant: "rose",
  width: 12,
  height: 4,
  theme: "dark",
});
renderer.root.add(persona);

// From an explicitly owned audio source; Float32Array mono samples in [-1, 1].
persona.audio = { input: input.push(samples) };
persona.state = "thinking";
// While speaking, supply output frames from a separate analyzer.
persona.audio = { output: output.push(outputSamples) };
persona.state = "speaking";
```

`Persona` exposes mutable `state`, `variant`, `audio`, and `paused` properties,
standard OpenTUI layout options, and `setTheme("light" | "dark")`. It owns no
controls or audio source. The host supplies both the theme and conversation
state. `AudioAnalyzer` emits fresh feature frames on fixed 20 ms hops; frames
and their arrays are read-only after publication. Listening uses input frames,
speaking uses output, and other states use their own motion. Missing frames
decay to quiet after 120 ms. Samples and visual histories stay bounded; each
stream should have its own analyzer, replaced when the source changes.
Feature frames carry a stream identity, hop revision, and the last attack's
revision and strength, so a render can consume an attack once even when several
audio hops arrive between paints. Old attacks expire after five analysis hops.

This establishes an experimental component API, not a live AgentVoice frontend
integration. The production pointer frontend and its audio-free protocol remain
unchanged. Tests use speech fixtures and fake capture devices, never hardware;
they do not establish live microphone fidelity or audible playback timing.

### Checks

```sh
bun run test
bun run typecheck
bun run lint
bun run generate:schema
bun run app-server:probe
```

Unit tests use fake protocol/media boundaries and no microphone or inference.
The native probe starts its own stock child, initializes, lists workspace
history, and closes—no turns or audio. `audio:probe` uses hardware and requires
an explicit live check.

See [AGENTS.md](../AGENTS.md) for the source map and [ADR 0009](adr/0009-one-foreground-workspace.md)
See [AGENTS.md](../AGENTS.md) for the source map and [ADR 0009](adr/0009-one-foreground-workspace.md)
for historical ownership decisions. [ADR 0024](adr/0024-server-and-pointer-frontend.md)
records the original terminal topology; [ADR 0032](adr/0032-loopback-browser-media-frontend.md)
adds the browser proof, and [ADR 0033](adr/0033-client-owned-native-media.md)
migrates both clients to the same client-owned-media boundary.

### Send text to the voice

From the conversation's workspace:

```sh
bun ~/code/agentvoice/scripts/voice-speak.ts "Hello, bananafish."
# Or select a workspace explicitly:
bun run voice:speak --workspace ~/code/myapp "Hello, bananafish."
```

The script discovers the live controller by exact canonical workspace, like
`voice:messages` and the web composer. Add `--thread <main-thread-id>` if
several controllers share that workspace. Use `--` before text beginning with
a dash. Empty text and text over 64 KiB are rejected.

It sends one native `thread/realtime/appendSpeech` request through the guarded
host connection, without starting a working-agent turn or resuming a
thread. Acceptance does not confirm audible playback or verbatim delivery.
There are no automatic retries. An ambiguous disconnect may occur after the
request was delivered; rerunning can repeat speech.

Use MCP/API runtime restart or start a new call to load changed runtime code. The script does not restart the app or voice
session. Other realtime mutations remain unavailable through the gateway.

### Persistent launch switches

`allow-full-access` and `debug` are optional top-level booleans in `server.json`.
Both default to false. `allow-full-access: true` uses the same permission-selector
override as `--allow-full-access`, including native startup and thread requests;
managed native requirements still apply. `debug: true` enables private per-workspace-session
protocol/media logs. CLI `--allow-full-access` and `--debug` win over false in the
file. New server workspace sessions, explicit runtime restarts and `new_session`
reload these settings; frontend reattachment and redial keep the current runtime's
settings. Model, effort and role retain their existing config keys.


### Persistent voice transcripts

Every call automatically records native voice items from startup to private JSONL
under `$XDG_STATE_HOME/agentvoice/voice/<workspace-hash>/<thread-id>.jsonl`
(default `~/.local/state`). The header retains the canonical workspace and thread.
Calls resuming a thread append; other threads and workspaces remain separate.
Recordings persist after calls end. The AgentVoice web UI reads the active thread's
recording while presenting the matching Agent history.

Completed items and recording boundaries are fsynced. Runtime interruptions,
unfinalized files and recovered partial writes are marked; disk failures appear
in server diagnostics. Draft deltas remain best-effort and speech predating this
feature cannot be recovered. Observed transcripts are never fed into native
history or model context and do not establish what was audibly heard.

The installer renames the previously managed `dev.agentvoice.default` service to
`io.arthack.agentvoice.server`, removing only a verified installer-owned old job.


### macOS privacy permissions for the service runtime

The waiting service uses a private runtime bundle, not the visible menu app. The
installer packages its own copy of Bun as a signed `AgentVoice.app` below
`~/.local/state/agentvoice/default/service/runtime/` (honoring XDG state).
It preserves Bun's runtime entitlements and adds microphone access plus an
AgentVoice usage description. Its Info.plist also explains local-network access,
and the LaunchAgent associates itself with that same responsible bundle so its
child processes use the `io.arthack.agentvoice` privacy identity. The Homebrew Bun
installation is never modified. The existing stable ad-hoc signing identity is
retained across installer updates, and modified bundles are refused.
Failed service updates restore the previous runtime before restarting its job.
Its `io.arthack.agentvoice` identity remains distinct from the menu app's
`io.arthack.agentvoice.menu` identity so existing client microphone grants remain
stable.

On the first voice call, allow AgentVoice microphone access in the macOS prompt.
If previously denied, enable AgentVoice under System Settings → Privacy & Security
→ Microphone, then close and reopen the voice frontend. The installer does not
change privacy grants or open audio while the server is waiting. A live connection
alone does not establish microphone permission: macOS can supply silent capture
when access is denied.

On macOS 15 and later, the first operation that reaches a device or service on a
directly connected network can show the AgentVoice local-network prompt. macOS may
reject that first operation while the prompt is open; retry it after choosing
**Allow**. The per-user toggle then appears under System Settings → Privacy &
Security → Local Network. If access was denied, enable AgentVoice there and retry
the operation; restart the affected client or service if its existing connection
does not recover.

The metadata becomes active only after a full installer publishes the signed
runtime bundle and restarts the LaunchAgent. Editing the checkout, rebuilding the
menu app, or restarting only the disposable Codex runtime does not replace this
bundle. The metadata allows macOS to ask and attribute AgentVoice and its children;
it does not grant local-network access, change the user's toggle, or bypass a
denial. It also adds no LAN listener, accepted origin, firewall rule, Bonjour
service, multicast entitlement, or network-client entitlement.

After installation, verify the runtime metadata, LaunchAgent association, signature,
and retained entitlements without opening a connection:

```sh
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/agentvoice"
/usr/bin/plutil -p "$state_root/default/service/runtime/AgentVoice.app/Contents/Info.plist" | rg 'CFBundleIdentifier|NS(LocalNetwork|Microphone)UsageDescription'
/usr/bin/plutil -p "$HOME/Library/LaunchAgents/io.arthack.agentvoice.server.plist" | rg 'AssociatedBundleIdentifiers|io\.arthack\.agentvoice'
/usr/bin/codesign --verify --strict "$state_root/default/service/runtime/AgentVoice.app"
/usr/bin/codesign -d -r- --entitlements :- "$state_root/default/service/runtime/AgentVoice.app/Contents/MacOS/agentvoice"
```
