# AgentVoice

A local Codex voice server with three terminal panes. `agentvoice server`
waits for a call; bare `agentvoice` opens a foreground smolmux instance containing
`agentvoice client`, `agentvoice attach voice`, and `agentvoice attach agent`
side by side. The server owns audio,
WebRTC, exact conversation identity, thread leases and its unmodified
`codex app-server` child. The frontend contains only connection status and
monochrome YOU/AGENT buttons, plus PUSH TO TALK when the microphone is muted.

The two attachment panes show “Waiting for voice connection” until this launch's
call reaches `live`, then attach to its exact workspace and thread. All three
apps run in local PTYs owned by the foreground smolmux process. Closing that
process or exiting any pane app ends all panes and the call; nothing persists
in smolmux's Companion. App failures also end the composition.
Press Ctrl+C twice within three seconds to exit the entire composition. The
first press shows a centered one-row overlay without resizing panes. Ctrl+C
is reserved for this exit action and never reaches the individual apps.
Divider drags survive placeholder replacement. Keyboard focus moves to the
working agent when it opens. Attachments are not automatically relaunched;
an attachment exit after runtime restart also ends the composition.

Bare `agentvoice` requires smolmux 0.9.2 or newer with its local PTY helper,
and `codex-viewer`, on PATH. Their existing installers own those dependencies;
AgentVoice does not install them. Use `agentvoice client` for the pointer frontend
alone. Scripts that previously used bare `agentvoice` for that frontend must now
use `agentvoice client`.

The direction is vanilla Codex with configurable prompts and settings: the
client-and-server experience, including voice, is the baseline. Because AgentVoice
implements its own frontend, matching Codex can require the same explicit values
that Codex's client sends; simply omitting fields does not establish parity.
Ordinary launches start a new conversation and inherit native permissions and
startup context. Raw native settings remain available, with visible warnings for modes
that this frontend cannot implement; passthrough is not a claim of feature parity.

## Start here

From a prepared checkout (Bun dependencies and native audio already built), run
these in separate terminals:

```sh
# Terminal 1: waits without opening audio or starting Codex
bun run /path/to/agentvoice/src/main.ts server

# Terminal 2: connects and starts a call
bun run /path/to/agentvoice/src/main.ts
```

On macOS, installation starts the default server as a user LaunchAgent. Run
`agentvoice` whenever you want a call. For manual use, run `agentvoice server`.
To choose an explicit workspace,
pass `--workspace /absolute/project` to both commands. Configuration, model,
voice, device, permission, role and conversation-selection flags belong to
`agentvoice server`, for example `agentvoice server --continue --fast`.
The composition and `client` accept only `--workspace` and `--help`.

One server and one active frontend are allowed per canonical workspace.
Both bare `agentvoice` and `agentvoice client` wait up to 30 seconds when the
previous frontend has disconnected but its call is still cleaning up, displaying
“Closing previous call…”. An active frontend still blocks a second call. Waiting
does not reserve a call, reconnect a disconnected client, or retry a refused call.
This requires a server running the same frontend observation contract; update
and restart an older server explicitly before using the updated client. Closing
the frontend terminal or terminating its process ends the call, closes audio
and the owned Codex child, and returns the server to waiting. There are no
pointer-frontend keybindings, including quit; process signals still perform cleanup.
The attached stock Codex TUI retains its own keyboard controls.
The default endpoint is independent of the current workspace generation. Without
`--workspace`, both commands use that endpoint from any launch directory.
Warnings and detailed failure reasons go to private service logs, or the terminal
when running the server manually.

```sh
agentvoice service status
agentvoice service restart
agentvoice service remove
```

Restart ends an active call and returns the server to waiting. Removal unloads
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

`agentvoice event-socket --workspace ~/code/myapp` prints the separate read-only
Unix endpoint for a live controller. UIs subscribe with `event.subscribe`, then
read `state.get` for the current inventory and a sequence watermark. The endpoint
reports native thread state and runtime availability during a call, including
native subagents. The same endpoint also carries typed
`voice.*` items and transcript deltas as a live-only socket stream, without history
backfill. The controller automatically saves private workspace/thread JSONL; use
`agentvoice attach voice` to view it live or after a call ends. An explicit `bun run voice:record
--workspace <dir> --out-dir <dir>` observer saves per-conversation JSONL for live
and saved `codex-viewer --voice-jsonl <file> [--follow]` viewing. `state.get` remains lifecycle-only. See the
[event protocol](docs/events.md) for prefix matching, snapshots, and limits, and
[events.schema.json](events.schema.json) for the machine-readable event types.

Event protocol **2** also exposes `conversation.*` messages, tool activity,
plans/diffs, reasoning, usage and errors for the orchestrator and native subagents.
Independent UIs can request an exact live-item snapshot, replay a bounded window
of conversation events, and page native thread/turn/item history without resuming
threads or submitting work. Use `runtime.mainThreadId` and native parent links to
select a conversation family. See the [conversation contract](docs/conversations.md)
for the methods and reconnect algorithm. Voice events remain live-only.
Event clients must match the event protocol. A new call creates new event and
control endpoints; rediscover them after a call ends.

### Child completion wake-ups

Each finished turn of an orchestrator-created native child immediately sends a
count-only wake-up: accumulated completion notices and the current number of
children still working. The `agentvoice_thread_mailbox_open` MCP tool returns
and clears completion metadata; native Codex supplies the full results.
Multiple pending notices and empty openings are expected. The mailbox survives
runtime replacement, has no per-message read receipts, and adds no system prompt.
Read-only `mailbox.*` events and mailbox snapshots/replay expose the same state
for external clients. See [thread mailbox](docs/thread-mailbox.md) for scope,
retry semantics and bounds.

### Attach a stock Codex TUI

Every active call supports stock Codex attachment from an additional terminal:

```sh
# Server terminal, from this prepared checkout:
bun run src/main.ts server --workspace ~/code/myapp

# Frontend terminal:
bun run src/main.ts --workspace ~/code/myapp

# Third terminal, for typed Codex interaction:
bun run src/main.ts attach --workspace ~/code/myapp
```

Installed commands use the same flags with `agentvoice`. Attachment selects a
live controller by canonical workspace; add `--thread <exact-id>` if more than
one matches. It launches the same stock Codex executable as the voice runtime
and resumes its exact live orchestrator thread. Type to start work or steer an
active turn, and follow native messages and tool activity. Steering follows
Codex's normal delivery timing; it may queue until a model/tool boundary.

This is the native orchestrator conversation, including raw voice handoff messages
such as `<realtime_delegation>`. Speech that stays within the voice agent produces
no new orchestrator turn. Typed input goes to the orchestrator; native Codex relays
its assistant output to an active voice session for a spoken response. The text
itself is not inserted into the voice transcript. A live trial confirmed typed
steering, continued orchestrator updates and an audible response on stock 0.153.4.

This experimental path was checked with stock Codex **0.153.4**. The runtime
always uses an authenticated private loopback WebSocket for native RPC. There
is no stdio transport or attachment enable/disable flag. Relaunch AgentVoice
after upgrading an older controller to use this behavior. Attaching preserves
the live thread's settings, including restricted permissions; the TUI's local
startup defaults do not replace them.

The attachment gateway permits reads, typed turns, interruption, and native
session settings for the selected orchestrator and its verified native descendants
in the same workspace. `/subagents` can discover and view those agents, including
completed agents with native history; Codex controls whether they accept direct input.
New/forked threads, history mutations,
persistent configuration/account changes, plugin controls and realtime control
are unsupported. The TUI does not show a live voice transcript or carry audio.
It shows native command/file/permission approvals, tool questions and MCP
elicitations for those threads, and forwards your answers to Codex.
AgentVoice leaves those questions pending in native Codex when no TUI is
attached; attaching later replays them. The gateway checks requests before
forwarding them. Navigation never changes the attachment's root grant, and unrelated
threads remain inaccessible. Explicit speech submission remains root-only.

Ordinary `/quit` detaches the TUI and leaves voice running. Codex's explicit
interrupt or running-task Exit action can interrupt native work. Redial preserves
attachment; call teardown or native failure disconnects
it. Run `attach` again for the current thread after a disconnect. No automatic
reconnect or input replay occurs. Use `agentvoice attach agent` instead of the stock
TUI's printed reconnect command, whose one-use ticket has ended.
Native and gateway credentials remain private;
there is no arbitrary endpoint flag or cross-machine mode.

Isolated stock TUI tests establish later owner turns, streaming replies, typed
steering and native approval round trips using local fake model responses.
Controller lifecycle tests use fake media. The earlier live trial established
simultaneous voice and TUI operation; it did not exercise every permission mode.
See [ADR 0022](docs/adr/0022-websocket-native-tui.md).

### Permissions

`--allow-full-access` is optional. Without it, AgentVoice leaves unset permission
fields to Codex and accepts native/configured sandbox and approval modes, including
named permission profiles. Native configuration and managed requirements still
apply. Workspace selection does **not** itself confine file access.

With the flag, AgentVoice explicitly requests `danger-full-access` and approval
policy `never`, overriding conflicting launch/request permission settings.
Unrelated raw native settings retain their normal precedence. The flag does not
bypass managed Codex requirements or grant connector consent.

Use `agentvoice attach agent` for native approvals, tool questions and MCP elicitations.
The voice console shows an interaction notice; Codex retains the pending request
until an attached TUI answers or native work is cancelled. AgentVoice neither
auto-approves nor auto-refuses these requests and maintains no approval queue.
Unsupported client-defined tools, auth callbacks, legacy requests and unknown
methods still receive a visible refusal or protocol error. Retired worker tools
remain retired. Restricted or missing permission reports do not stop voice or
prevent attachment.

Native protocol reference: [Codex approvals and connector interaction](https://learn.chatgpt.com/docs/app-server#approvals).

Requirements: Bun, stock Codex with the experimental realtime app-server
surface, an authenticated Codex account, built native duplex audio, and a
terminal with microphone permission. Headphones are recommended: there is no
echo cancellation. The original voice semantics were verified on Codex 0.147;
run the native protocol probe before changing the supported runtime.

### WebRTC compatibility default

AgentVoice sends realtime **v3 by default** for WebRTC. Ordinary launches need
no personal configuration workaround. This is a documented frontend transport
choice that aligns with the inspected Codex desktop's newer client-owned-call
path; the owned Codex app-server remains unmodified. That desktop path is
conditional, so it does not establish every account's active version. See the
[client/server comparison](docs/field-guide.md#default-comparison-audit).

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
no TUI buttons or keybindings; in-call Fresh remains removed. Control protocol 4
exposes status, redial, restart and thread-mailbox opening with matching MCP tools; see the
[control API](docs/api.md) and [orchestrator guide](USAGE.md).

### Installation

Installation is deliberately separate. `bun run setup` checks prerequisites
and builds audio; `bun run native:build` rebuilds it. Both build without opening
an audio device. `scripts/install.sh --install` is the single editable installer;
`bun run cli:install` is an alias, and AgentStart's `install-agent-clis` delegates
to the same contract. Installation does not verify authentication or connect a
voice session; live voice compatibility is a separate check.

The installer requires Bun 1.3+, an executable stock Codex (`CODEX_PATH` or PATH),
a C11 compiler (Zig, clang or cc), and a clean checkout with the AgentVoice GitHub
origin. Codex is checked for presence, not invoked; login and realtime compatibility
are separate runtime prerequisites. It runs `bun install --frozen-lockfile`, builds
native audio to a temporary file, then atomically links `~/.local/bin/agentvoice`
directly to `src/main.ts` and records the commit in
`~/.local/state/agentvoice/deployed-sha` (`XDG_STATE_HOME` honored). The link preserves
caller cwd. On macOS, it then installs `~/Library/LaunchAgents/io.arthack.agentvoice.server.plist`
and bootstraps the waiting server in the logged-in user's GUI domain. Rerunning
installation restarts that job and ends any active call. The job runs while
logged in; sleep suspends it. A manual default server must be stopped before
installing, since it owns the same socket.

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
are refused. A link to another checkout requires its matching receipt; an existing
link into this checkout can be adopted or refreshed. The receipt records the last
installation, not the current state of subsequent edits. Build failures leave the
command/receipt untouched; a failed compile preserves the prior native library.
Interrupted link/receipt publication is recoverable by rerunning after clearing
any stale `.install-lock`; check for a running installer before manual removal.
If another command shadows the link on PATH, installation warns without deleting it.

For disposable tests or alternate destinations, set absolute
`AGENTVOICE_INSTALL_BIN_DIR` and `AGENTVOICE_INSTALL_STATE_DIR` paths, and pass
`--command-only` to avoid touching the user's LaunchAgent. These two overrides
move only command publication and its receipt; service state follows XDG_STATE_HOME.
Non-macOS installations publish the command only. No prompts, skills, credentials,
Codex configuration or shell profiles are changed, and installation never starts
the TUI or a voice call. An unrelated or edited plist is refused. A service failure
is reported separately if command publication already succeeded.

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

The default server selects the current generation at each call start and pins it
through runtime restarts. A later generation takes effect on the next call; old
directories and native history remain. There is no reset, deletion or transcript
cleanup operation. Native context policy is unchanged.

An explicit CLI workspace selects a separate workspace socket; pass the same
`--workspace` to its server and frontend. A file-configured workspace pins the
default server's calls while retaining the default endpoint. Workspace settings
are selected at server startup; restart the service to change that selection.
Read-only discovery commands and `attach` still accept `--workspace <directory>`;
their omitted workspace remains the invoking directory.

Ordinary launch starts a new conversation without looking up a previous one.
Explicit `--continue` lists native unarchived app-server history, newest-updated
first, and continues the latest non-ephemeral AgentVoice main conversation whose cwd
matches exactly. Legacy worker threads, child threads and other clients' threads are excluded.
On Codex 0.153.3, app-server-created AgentVoice threads are listed under the
`vscode` source kind and list rows can omit their saved `threadSource`; AgentVoice
queries both native categories and confirms ownership with `thread/read`.
If none exists, a new conversation starts. Lookup/resume failures are errors,
not an excuse to silently create a replacement. Explicit `--resume` must match
an eligible conversation in the selected workspace.

Explicit `--continue` or `--resume` resumes the selected working thread.
Each voice connection starts without AgentVoice reading or injecting earlier
speech or adding its own reconnect instruction. This applies to continue,
explicit resume and automatic renewal. Native saved conversation history remains intact.

AgentVoice leaves the native startup snapshot (including Recent Work) unset,
so Codex supplies its native context. Set `voice.include-startup-context` to
`false` to skip it, or `true` to request it explicitly in your selected `server.json`. Explicit raw `voice.extra.initialItems` also remain supported,
including `[]` and `null`; populated initial items require effective realtime v3.
Prompt files and other native config overrides keep their existing behavior.

Automatic spoken-history replay has been removed. If your config contains
`voice.replay-spoken-history`, remove that key, even if its value is `false`.
It errors at load with removal guidance, as does the older `voice.quiet-resume`
key. AgentVoice does not migrate or delete your configuration or saved history.
See [ADR 0017](docs/adr/0017-remove-spoken-history-replay.md) for the decision.

Each frontend connection begins a new call using the server's selected workspace
and conversation policy. The default starts a new native conversation;
`server --continue` selects the latest eligible one for every call, and
`server --resume <id>` selects that exact saved conversation. There is no
in-call conversation switch. A per-thread kernel lock protects each active call.

Closing a call stops voice and app-owned work and closes its Codex child.
**Work does not continue after the call ends.** Native saved history remains
available to a subsequent call; ephemeral/unpersisted threads cannot be resumed.
Workspace selection is not a memory or security sandbox.

## Features and controls

- Click YOU to toggle microphone mute and AGENT to toggle speaker mute.
- While the microphone is muted, hold PUSH TO TALK to speak. Releasing restores
  mute; terminal blur and frontend disconnect cancel the hold.
- Buttons use white and grey only. Muted channels are greyed out. There are no
  animations, meters, timers, extra status rows, modal or application keybindings.
- The top line shows only the connection phase. LIVE confirms the media link,
  not that native work completed or speech was heard.
- Full-duplex audio uses native miniaudio, Opus and WebRTC. Automatic renewal
  maintains the connection without changing its conversation or configuration.
- Server settings and prompt files load once per runtime generation. Runtime
  restart or a later call reloads file contents; changing launch flags or the workspace requires a new server.

Warnings appear in the server terminal. With `--debug`, private per-call logs
also capture protocol/media details. Native item deltas remain available through
the read-only event socket; the frontend does not display them.

Call startup validates prompts/protocol and native readiness before opening audio.
The WebRTC offer follows device readiness. Audio failure closes the owned child;
native conversation creation or resume may already have happened.

## Configuration and prompts

Keep `~/.config/agentvoice/server.json` (or
`$XDG_CONFIG_HOME/agentvoice/server.json`). Its legacy filename does **not**
imply a background server. Use `--config <path>` for another file.

`server.json.example` is a no-op example. The generated
[JSON schema](server.schema.json) documents every key; the
[field guide](docs/field-guide.md) maps the current surface and remaining cuts.

Common launch options:

```sh
agentvoice server --workspace ~/code/myapp --model <model-id> --effort high
agentvoice server --fast
agentvoice server --resume <thread-id> --no-fast
agentvoice server --voice <voice-name> --device 1 --output-device 2
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
read during call preflight and cached until the call ends. A later call reloads
files using the server's launch arguments and pinned canonical workspace.

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
see the [default comparison audit](docs/field-guide.md#default-comparison-audit).

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
and an empty file sends empty text. No custom prompt files ship with the app.

| File | Agent | Native control |
| --- | --- | --- |
| `VOICE_AGENT_SYSTEM_PROMPT.md` | voice | Realtime `prompt`: replaces Codex's built-in voice prompt |
| `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` | voice | Text Codex renders after its built-in voice prompt, through the startup-context slot (below) |
| `VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md` | orchestrator | Thread `baseInstructions`: replaces the entire base prompt (visible warning; `personality` no longer applies) |
| `VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md` | orchestrator | Thread `developerInstructions`: Codex's developer message after the base prompt |
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

A present name must load: an unreadable file, a directory or a broken link fails
before Codex starts, even if a raw field would override the contents. Symlinks to
regular files work. Contents are cached by the active runtime for the call,
then reread by the next call. Session-boundary instructions and voice prompts ride every realtime start,
including automatic renewal. Explicit voice context items use raw `voice.extra.initialItems`,
not prompt files; AgentVoice generates no history items of its own.

The former names (`VOICE.md`, `ORCHESTRATOR.md`, `ORCHESTRATOR_BASE.md`,
`ORCHESTRATOR_SESSION_START.md`, `ORCHESTRATOR_SESSION_END.md`,
`VOICE_SEED_DEVELOPER.md`, `VOICE_SEED_USER.md`, `VOICE_SEED_ASSISTANT.md`) and
the retired `prompt-files` config section no longer load anything: a leftover file
produces a visible warning without being read, and the config key is an unknown
option. Rename or remove them yourself; nothing is migrated or deleted. Removing
an override does not erase earlier instructions/messages from a resumed native
conversation; use `--no-continue` for a new conversation when testing the
baseline. Native global and workspace instructions, skills, MCPs and hooks still
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

Select the repository's `roles/default` role with
`agentvoice server --role ./roles/default` from the repository directory.
It is not automatically selected when `--role` and the config's `role` key
are absent.

| Role file | Effect in AgentVoice |
| --- | --- |
| `SYSTEM_PROMPT.md` / `APPEND_SYSTEM_PROMPT.md` | Orchestrator `baseInstructions` / `developerInstructions`: the general role prompt every harness receives |
| `VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md` / `VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md` | Voice-specific stand-ins for the general file of the same kind, used by AgentVoice only |
| `VOICE_AGENT_SYSTEM_PROMPT.md` / `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` | Voice agent prompt, as in the prompt override files above |
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

The controls below are configurable. AgentVoice leaves `include-startup-context`,
tail flush and startup-text overrides unset, leaving native resolution in charge.
The shipped `server.json.example` does not configure them. This applies to ordinary
launch, continue, explicit resume and automatic renewal. Codex currently includes its
startup snapshot when the field is omitted. This deliberately inherits server
behavior; desktop disables this snapshot alongside its own context machinery,
so omission does not establish identical desktop context. See [ADR 0020](docs/adr/0020-native-launch-defaults.md).

A saved conversation is not the same as a voice call: subsequent calls may
resume the same conversation, while the default starts a new conversation. Codex can give
each call a startup snapshot and can deliver leftover speech to the working
agent when a call ends. AgentVoice adds no automatic speech replay between calls.

The following are optional overrides. Merge the setting into your config and relaunch;
these controls do not hot reload.

Explicitly request Codex's startup snapshot, including Recent Work. Codex 0.153.4 bundles
that with current working-thread context and a machine/workspace map; there is
no native Recent Work-only switch. This can inform even a `--no-continue` call
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

Removing `include-startup-context` restores native resolution; raw
`voice.extra.includeStartupContext: null` also requests native resolution. Other
unset native controls still defer to Codex; `false` and `""` are explicit values.
`voice.extra` wins over
the named voice controls, and `orchestrator.extra.config` replaces
`orchestrator.config` as a whole, so remove conflicting raw overrides too.

## Native work, no custom worker layer

Codex owns the voice-to-working-agent handoff, tools, subagents and their native
events. AgentVoice adds completion-tally wake-ups and a metadata-only thread
mailbox; native Codex still starts the children and delivers their results.
AgentVoice does not add worker execution tools or archive/delete completed work. An explicit MCP/API restart
handoff is submitted once through native `turn/start` after exact resume and live media.
It generates no worker-specific instructions; optional operator prompt overrides
still pass through.

`orchestrator.dispatch` and `orchestrator.dispatch-reports` are retired: remove
both keys from old configuration, even when set to `false`. Existing conversation
history is untouched. Codex can retain old dynamic tool definitions on resume;
calls to `dispatch_worker`, `check_workers` or `cancel_worker` now receive an
immediate failed tool result and a visible retirement notice in the server terminal. A server launched with
`--no-continue` starts without the old definitions; there is no automatic switch,
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
`frontend/` default and explicit-workspace sockets, `thread-locks/`, private per-call controller
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

The explicit installer manages only its `io.arthack.agentvoice.server` LaunchAgent.
Normal launches never install services, migrate history or clean private state.
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
different way. RMS, peaks, sixteen frequency bands, and attack detection drive
their geometry; conversation state is always supplied explicitly.

```sh
bun run personas
bun run personas --variant rose --view sizes
bun run personas --wav speech.wav --state speaking
bun run personas --mic
```

The default demo analyzes two bundled, locally synthesized speech clips with
an authored conversation timeline. Demo and WAV replay are **silent**: the PCM
drives the visuals without opening a speaker. WAV input supports mono/stereo
PCM16 and float32 at 8–96 kHz, bounded to 24 MiB and 20 ms–120 seconds. The lab
does not start a voice call, connect to the server, or run Codex.

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

`CODEX_PATH=/absolute/path/to/codex bun scripts/attachment-tui-probe.ts` starts an
opt-in macOS fixture with disposable state, a localhost fake Responses API,
external network denied for the native child, and no audio. Its `subagent` then
`owner` commands create a native subagent using a scripted tool call; the fixture
explicitly enables multi-agent v2. Use the printed workspace, `nativeHome` and
state directory to attach an isolated stock TUI. In the September 6, 2026 check
with Codex 0.153.4, `/subagents` listed a completed child, opened its saved reply,
retained native direct-input restrictions, and returned to Main. The TUI was also
restricted to loopback/Unix sockets. “No sub-agents running” remains normal once
all children have completed.

The navigation request audit used upstream tag `rust-v0.153.4`
(`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`), specifically
`codex-rs/tui/src/app/agent_picker.rs`, `app/session_lifecycle.rs`,
`app/loaded_threads.rs` and `app_server_session.rs`. The gateway admits the
picker's ancestry-filtered list fields and verifies each result independently;
see [ADR 0024](docs/adr/0024-descendant-tui-attachment.md).

See [AGENTS.md](AGENTS.md) for the source map and [ADR 0009](docs/adr/0009-one-foreground-workspace.md)
for historical ownership decisions; [ADR 0024](docs/adr/0024-server-and-pointer-frontend.md) defines the current topology.

### Send text to the voice

From the conversation's workspace:

```sh
bun ~/code/agentvoice/scripts/voice-speak.ts "Hello, bananafish."
# Or select a workspace explicitly:
bun run voice:speak --workspace ~/code/myapp "Hello, bananafish."
```

The script discovers the live controller by exact canonical workspace, like
`voice:messages` and `agentvoice attach agent`. Add `--thread <main-thread-id>` if
several controllers share that workspace. Use `--` before text beginning with
a dash. Empty text and text over 64 KiB are rejected.

It sends one native `thread/realtime/appendSpeech` request through the guarded
attachment connection, without starting a working-agent turn or resuming a
thread. Acceptance does not confirm audible playback or verbatim delivery.
There are no automatic retries. An ambiguous disconnect may occur after the
request was delivered; rerunning can repeat speech.

Use MCP/API runtime restart or start a new call to load changed runtime code. The script does not restart the app or voice
session. Other realtime mutations remain unavailable through attachment.

### Persistent launch switches

`allow-full-access` and `debug` are optional top-level booleans in `server.json`.
Both default to false. `allow-full-access: true` uses the same permission-selector
override as `--allow-full-access`, including native startup and thread requests;
managed native requirements still apply. `debug: true` enables private per-call
protocol/media logs. CLI `--allow-full-access` and `--debug` win over false in the
file. New calls and explicit runtime restarts reload these settings; redial keeps
the current runtime's settings. Model, effort and role retain their existing config keys.


### Attach to the working agent or voice transcript

```sh
agentvoice attach agent
agentvoice attach voice
agentvoice attach voice --list
agentvoice attach voice --thread <thread-id>
# Either target accepts an explicit workspace:
agentvoice attach voice --workspace ~/code/myapp
```

Both commands use the default server's active workspace, even if a newer default
workspace directory has been created. When idle they use its selected workspace;
without a server they use the configured workspace or current default generation.
Bare `agentvoice attach` now requires `agent` or `voice`.

Every call automatically records native voice items from startup to private JSONL
under `$XDG_STATE_HOME/agentvoice/voice/<workspace-hash>/<thread-id>.jsonl`
(default `~/.local/state`). The header retains the canonical workspace and thread.
Calls resuming a thread append; other threads and workspaces remain separate.
Recordings persist after calls end. `attach voice` opens the active transcript,
or the latest saved recording when no call is active, with `codex-viewer --follow`.
Closing the viewer has no effect on recording or the call. Install `codex-viewer`
on PATH to view them; `--list` requires no interactive terminal.

Completed items and recording boundaries are fsynced. Runtime interruptions,
unfinalized files and recovered partial writes are marked; disk failures appear
in server diagnostics. Draft deltas remain best-effort and speech predating this
feature cannot be recovered. Observed transcripts are never fed into native
history or model context and do not establish what was audibly heard.

The installer renames the previously managed `dev.agentvoice.default` service to
`io.arthack.agentvoice.server`, removing only a verified installer-owned old job.


### macOS microphone permission for the service

The installer packages its own copy of Bun as a signed `AgentVoice.app` below
`~/.local/state/agentvoice/default/service/runtime/` (honoring XDG state).
It preserves Bun's runtime entitlements and adds microphone access plus an
AgentVoice usage description. The LaunchAgent and its runtime children use this
executable; the Homebrew Bun installation is never modified. A stable app signing
identity is retained across installer updates, and modified bundles are refused.
Failed service updates restore the previous runtime before restarting its job.

On the first voice call, allow AgentVoice microphone access in the macOS prompt.
If previously denied, enable AgentVoice under System Settings → Privacy & Security
→ Microphone, then close and reopen the voice frontend. The installer does not
change privacy grants or open audio while the server is waiting. A live connection
alone does not establish microphone permission: macOS can supply silent capture
when access is denied.
