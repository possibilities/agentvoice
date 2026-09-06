# AgentVoice

A foreground Codex voice app with a retained terminal controller. The controller
owns the TUI, exact conversation identity, thread leases, and local control
plane. Its disposable runtime child owns audio, WebRTC, AgentVoice runtime code,
and an unmodified `codex app-server` child that owns agents, tools, and native
conversation history.

The direction is vanilla Codex with configurable prompts and settings: the
client-and-server experience, including voice, is the baseline. Because AgentVoice
implements its own frontend, matching Codex can require the same explicit values
that Codex's client sends; simply omitting fields does not establish parity.
Ordinary launches start a new conversation and inherit native permissions and
startup context. Raw native settings remain available, with visible warnings for modes
that this frontend cannot implement; passthrough is not a claim of feature parity.

## Start here

From a prepared checkout (Bun dependencies and native audio already built):

```sh
bun run ~/code/agentvoice/src/main.ts
bun run ~/code/agentvoice/src/main.ts --workspace ~/code/myapp --continue
bun run ~/code/agentvoice/src/main.ts --resume <thread-id>
bun run ~/code/agentvoice/src/main.ts --allow-full-access
```

The absolute source command preserves your shell's working directory. In the
examples, replace the checkout path if needed. Once installed, `agentvoice`
is shorthand for the same entrypoint. `agentvoice console` is a compatibility
alias; `--fresh` is an alias for `--no-continue`.

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
reports native thread state and runtime availability across Fresh and runtime
restart, including native subagents. The same endpoint also carries typed
`voice.*` items and transcript deltas as a live-only stream, without history
backfill or controller transcript storage. An explicit `bun run voice:record
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
A full foreground relaunch and updated protocol-2 clients are required; runtime
restart does not upgrade the retained controller's socket protocol.

### Attach a stock Codex TUI

Every voice launch supports attachment from a second terminal:

```sh
# First terminal, from this prepared checkout:
bun run src/main.ts --workspace ~/code/myapp

# Second terminal, from the same checkout:
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

The attachment gateway permits selected-thread reads, typed turns, interruption,
and native session settings, including permission changes. New/forked threads, history mutations,
persistent configuration/account changes, plugin controls and realtime control
are unsupported. The TUI does not show a live voice transcript or carry audio.
It shows native command/file/permission approvals, tool questions and MCP
elicitations for the selected thread, and forwards your answers to Codex.
AgentVoice leaves those questions pending in native Codex when no TUI is
attached; attaching later replays them. The gateway checks requests before
forwarding them, preserving the selected workspace/thread.

Ordinary `/quit` detaches the TUI and leaves voice running. Codex's explicit
interrupt or running-task Exit action can interrupt native work. Redial preserves
attachment; Fresh, runtime restart, native failure, or AgentVoice quit disconnects
it. Run `attach` again for the current thread after a disconnect. No automatic
reconnect or input replay occurs. Use `agentvoice attach` instead of the stock
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

Use `agentvoice attach` for native approvals, tool questions and MCP elicitations.
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
Automatic retries pause after three consecutive short-lived failures and keep
the last cause visible. `r` retries the same launch settings. An orchestrator
can request a full runtime restart to apply a changed runtime/configuration
snapshot while the controller stays open; see [control API](docs/api.md).
An optional `handoffPrompt` on that restart request gives the resumed working
agent a task after the exact conversation and live media are ready. Submission
status is tracked separately from restart success; work and audible speech still
need to be observed. See [restart handoffs](USAGE.md#give-the-restarted-agent-a-task).
The new request uses control protocol 2 and requires a full foreground relaunch
to activate its controller; runtime restart alone does not upgrade the API.

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
caller cwd. TypeScript edits are live; native source changes need a rebuild.
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
`AGENTVOICE_INSTALL_BIN_DIR` and `AGENTVOICE_INSTALL_STATE_DIR` paths. The installer
changes no services, prompts, skills, credentials, Codex configuration or shell
profiles, and does not launch the TUI.

## Conversations and workspaces

One canonical workspace per launch: `--workspace` > an explicit
`orchestrator.workspace` in the config > launch cwd. Relative workspace paths
resolve from launch cwd; relative additional runtime roots resolve from that
workspace. Symlink paths canonicalize to the same directory.

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
explicit resume, redial and Fresh. Native saved conversation history remains intact.

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

Fresh changes the conversation, not the workspace. It cuts the old media path
before opening the new one. Old native history is not deleted, and any native
work still active in the old conversation stays there. A per-thread kernel lock prevents two AgentVoice
launches from controlling the same conversation; other workspaces and explicit
fresh conversations can run independently.

Quitting stops voice and app-owned work, shuts down the child and restores the
terminal. **Work does not continue in the background.** The next launch can
resume saved native history. A full runtime restart is separate from Fresh: the
controller retains the exact current thread and starts a new runtime without
using normal continue/history selection to choose a replacement thread.
Ephemeral conversations and native threads with no saved rollout cannot be
continued after exit. Workspace selection is not a memory or security sandbox.

## Features and controls

- Full-duplex microphone/speaker audio: in-process miniaudio device, Opus and
  WebRTC; live signal meters and phase/timer display.
- `ctrl+k`: command palette. `m` microphone, `s` speaker, `r` redial,
  `f` fresh conversation, `q` or `ctrl+c` quit.
- Click the YOU/AGENT zones to toggle microphone/speaker mute. With the mic
  muted, the bottom band is hold-only push-to-talk. In release-capable
  terminals, hold Space to temporarily unmute the mic; releasing always restores
  mute, even after a quick tap. M/S toggle on press in all terminals. Terminals
  without key-release reporting leave Space inert. Opening the palette cancels
  active holds; a missing Space release times out safely.
- Redial renews voice on the same conversation using overlapping WebRTC peers;
  automatic renewal uses the same path. Fresh closes old media first.
- Device selection, model/effort/voice overrides and config/prompt passthrough.
  Redial and Fresh use the active runtime snapshot; a full runtime restart
  rereads the pinned launch inputs.
- Optional runtime-restart handoff: save a prompt before teardown and submit it
  once to the resumed working agent after media readiness, with recoverable
  submission status through the existing control tools.
- Per-launch opt-in debug logs; no phone remote, pairing, Android packaging,
  separate Server, resident service or Herdr integration.

The upper field shows workspace, whether the conversation was started or continued,
and its native ID (truncated to fit). Model, effort and voice protocol reflect
Codex reports, not requested values; missing model data shows `unknown`. Identity
rows hide below 12 terminal rows. `LIVE` means the media link is connected, not
that Codex work completed. The most recent audio/transport or interaction notice
stays visible without `--debug`; detailed media tracing remains opt-in.
Without `--debug`, AgentVoice asks Codex to omit unused text, reasoning, tool-output,
plan/diff, usage, and legacy flat realtime transcript/audio streams. Native
item transcript deltas remain enabled for the event socket. Lifecycle and settings
notifications remain enabled. Debug launches retain those streams and decode
WebRTC data-channel events for diagnostics; ordinary launches skip that work.

Launch validates prompts/protocol, selects the native conversation and confirms
permissions/Fast before opening audio. The WebRTC offer follows device readiness.
If opening audio fails, the owned child is closed; native conversation creation
or resume may already have happened.

## Configuration and prompts

Keep `~/.config/agentvoice/server.json` (or
`$XDG_CONFIG_HOME/agentvoice/server.json`). Its legacy filename does **not**
imply a background server. Use `--config <path>` for another file.

`server.json.example` is a no-op example. The generated
[JSON schema](server.schema.json) documents every key; the
[field guide](docs/field-guide.md) maps the current surface and remaining cuts.

Common launch options:

```sh
agentvoice --workspace ~/code/myapp --model <model-id> --effort high
agentvoice --fast
agentvoice --resume <thread-id> --no-fast
agentvoice --voice <voice-name> --device 1 --output-device 2
agentvoice --config ./voice-settings.json --debug
agentvoice --role researcher
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
agentvoice -c model_reasoning_effort=high
agentvoice --codex-config 'shell_environment_policy.include_only=["PATH","HOME"]'
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
| `codex-config` / `-c` | Owned Codex child starts | Entire launch, including Fresh/redial |
| `orchestrator.config` / `orchestrator.extra` | Conversation starts or resumes | Native thread configuration/history rules |
| `voice.extra` | Realtime voice session starts | Each voice start/redial |

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
read by a preflighted runtime candidate and cached for that runtime. Fresh and
redial reuse the active runtime snapshot; a full runtime restart rereads the
pinned launch inputs and replaces Codex. It cannot adopt later shell-environment
changes. Disabled realtime support fails clearly; `cwd` must be selected with
`--workspace`. The owned native RPC transport is always WebSocket. Native keys
remain passthrough, not a promise that your Codex version
supports them or detects typos. No global config, prompt or skill
policy is written. See [native override syntax](https://developers.openai.com/codex/config-advanced/#one-off-overrides-from-the-cli).

### Native voice protocol

AgentVoice defaults the final WebRTC request to `version: "v3"` when the version
is unset. This restores service compatibility, rather than inferring a default
from another Codex UI. The choice applies on start, continue, explicit resume,
redial and Fresh. No configuration file is created or edited.

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

These are launch overrides, including for continued conversations and Fresh.
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

The status line says `Work: Fast` or `Work: Standard` when Codex reports that
setting, and appends `requested` if the response lacks tier information.
This is the native configured tier, not per-request billing telemetry or a
guaranteed speedup. A native null tier means no accelerated tier; a missing
field means unknown. See the [official Fast documentation](https://learn.chatgpt.com/docs/agent-configuration/speed).

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
regular files work. Contents are cached by the active runtime for redial and
Fresh, then reread by a full runtime restart. Session-boundary instructions and voice prompts ride every realtime start,
including redial. Explicit voice context items use raw `voice.extra.initialItems`,
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
apply, even to Fresh. AgentVoice does not automatically enable AgentStart skills
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
agentvoice --role researcher      # ~/.config/agentroles/researcher
agentvoice --role ./roles/researcher
```

`--role` takes a name under `$AGENTROLES_HOME` (default `~/.config/agentroles`)
or a directory path. The `role` key in `server.json` is the file-level default;
`--role` overrides it. Names use letters, digits, `_` and `-` only.

The repository includes a minimal role at `roles/default` with a no-op
`role-smoke-test` skill. Select it with `agentvoice --role ./roles/default`
from the repository directory, then ask to use `$role-smoke-test` to check
discovery. It contains no prompt overrides or MCP configuration. It is not
automatically selected when `--role` and the config's `role` key are absent.
The manager-priming skill will be developed separately.

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
launch, continue, explicit resume, redial and Fresh. Codex currently includes its
startup snapshot when the field is omitted. This deliberately inherits server
behavior; desktop disables this snapshot alongside its own context machinery,
so omission does not establish identical desktop context. See [ADR 0020](docs/adr/0020-native-launch-defaults.md).

A saved conversation is not the same as a voice call: redial starts another
call on the same conversation; Fresh starts a new conversation. Codex can give
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
events. AgentVoice does not add worker tools, start extra worker threads, compose
completion reports, or archive/delete completed work. The optional restart
handoff submits one caller-provided task through native `turn/start` after resume;
its submission status is separate from the native work's outcome.
It generates no worker-specific instructions; optional operator prompt overrides
still pass through.

`orchestrator.dispatch` and `orchestrator.dispatch-reports` are retired: remove
both keys from old configuration, even when set to `false`. Existing conversation
history is untouched. Codex can retain old dynamic tool definitions on resume;
calls to `dispatch_worker`, `check_workers` or `cancel_worker` now receive an
immediate failed tool result and a visible retirement notice. Fresh or
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
CODEX_HOME=/absolute/path/to/codex-home agentvoice --allow-full-access
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
`thread-locks/`, private live-controller discovery records under `control/`, and
`runs/<time>-<pid>.log` with `--debug`. Every runtime also creates a
private `native-ws-*` directory holding the owned listener token; normal runtime
shutdown removes it. Lock files are inert after exit; the
kernel owns their lifetime. Discovery records contain the loopback bearer
capability, use private directory and file modes, and are removed on normal
controller shutdown. `mcp-config` validates the live control socket and ignores
stale crash residue rather than choosing it or deleting it.
Debug logs may contain prompts, transcripts and protocol details—keep them private.
They also record the selected workspace and conversation ID.

`server`, `resident` and `remote` commands, and the `remote` config section,
now fail with a retirement message. Remove a retired `remote` section from
your chosen config before launching. Other unknown retired keys are rejected
by strict config validation.

No installer, uninstall, service stop, history migration or private-state cleanup
runs automatically. Previously installed LaunchAgents, old logs, pairings,
`thread.json` and `workers.json` are untouched and unused by this source.
An old running service will not honor the new per-thread lock: stop/migrate it
explicitly before sharing its conversation with this version. This change does
not control those old processes.

## Development

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
See [AGENTS.md](AGENTS.md) for the source map and [ADR 0009](docs/adr/0009-one-foreground-workspace.md)
for the ownership decision.

### Send text to the voice

From the conversation's workspace:

```sh
bun ~/code/agentvoice/scripts/voice-speak.ts "Hello, bananafish."
# Or select a workspace explicitly:
bun run voice:speak --workspace ~/code/myapp "Hello, bananafish."
```

The script discovers the live controller by exact canonical workspace, like
`voice:messages` and `agentvoice attach`. Add `--thread <main-thread-id>` if
several controllers share that workspace. Use `--` before text beginning with
a dash. Empty text and text over 64 KiB are rejected.

It sends one native `thread/realtime/appendSpeech` request through the guarded
attachment connection, without starting a working-agent turn or resuming a
thread. Acceptance does not confirm audible playback or verbatim delivery.
There are no automatic retries. An ambiguous disconnect may occur after the
request was delivered; rerunning can repeat speech.

An already-running runtime must be restarted from the updated checkout to load
the gateway's appendSpeech support. The script does not restart the app or voice
session. Other realtime mutations remain unavailable through attachment.
