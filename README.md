# AgentVoice

A foreground Codex voice app with a terminal UI. One AgentVoice process owns
the TUI, audio, WebRTC and coordination runtime; an unmodified `codex app-server`
child owns the agents, tools and native conversation history.

The direction is vanilla Codex with configurable prompts and settings.
Full access and workspace-local conversation selection are intentional product
policies. Raw native settings remain available, with visible warnings for modes
that this frontend cannot implement; passthrough is not a claim of feature parity.

## Start here

From a prepared checkout (Bun dependencies and native audio already built):

```sh
bun run /Users/arthack/code/agentvoice/src/main.ts --allow-full-access
bun run /Users/arthack/code/agentvoice/src/main.ts --allow-full-access --workspace ~/code/myapp
bun run /Users/arthack/code/agentvoice/src/main.ts --allow-full-access --no-continue
bun run /Users/arthack/code/agentvoice/src/main.ts --allow-full-access --resume <thread-id>
```

The absolute source command preserves your shell's working directory. In the
examples, replace the checkout path if needed. Once installed, `agentvoice`
is shorthand for the same entrypoint. `agentvoice console` is a compatibility
alias; `--fresh` is an alias for `--no-continue`.

### Full access is required

Every voice launch requires `--allow-full-access`, including `console`, continue
and resume. Without it the command errors (exit 2) before reading config, starting
Codex or opening the microphone. No confirmation dialog, environment variable,
config key or remembered consent substitutes for the flag. Help remains available
without it; retired commands report their migration errors without launching.

This permits unrestricted command filesystem/network access with native
`danger-full-access` and approval policy `never`. Workspace selection does **not**
confine file access. AgentVoice verifies Codex's effective start/resume responses,
including Fresh. Missing/restricted permission reports fail closed. Managed Codex
requirements are never bypassed or rewritten to make launch succeed.

Incompatible `sandbox`, `approval-policy`, named permission profiles and native
config/extra selectors error. Matching legacy values remain accepted; the only
supported profile is `:danger-full-access`. Permissions are a product invariant,
not an inherited vanilla default or a setting for the app to relax later.

Full access does not answer tool questions, authenticate connectors or grant
their consent. Unexpected command/file/permission requests are denied, MCP
elicitations declined, and unsupported input/auth/unknown requests receive a
protocol error, never invented answers or empty successes. A persistent TUI
notice explains the refusal without interrupting the whole conversation. Complete
required interaction in a supporting Codex client; AgentVoice offers no approval
UI. A native permission downgrade stops the app-owned child.

Native protocol reference: [Codex approvals and connector interaction](https://learn.chatgpt.com/docs/app-server#approvals).

Requirements: Bun, stock Codex with the experimental realtime app-server
surface, an authenticated Codex account, built native duplex audio, and a
terminal with microphone permission. Headphones are recommended: there is no
echo cancellation. The original voice semantics were verified on Codex 0.147;
run the native protocol probe before changing the supported runtime.

### WebRTC compatibility default

AgentVoice sends realtime **v3 by default** for WebRTC. Ordinary launches need
no personal configuration workaround. This is a documented frontend transport
choice; the owned Codex app-server remains unmodified.

On September 5, 2026, stock Codex 0.153.3's omitted-version WebRTC request was
rejected with `AVAS requires OpenAI-Alpha: quicksilver=v2.` Explicit v3 connected,
and the operator confirmed the launch works. In [Codex 0.153.3 source](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/realtime_conversation.rs),
v3 sends that required header; native WebRTC omission falls back to v1 and sends
`quicksilver=v1`. The header's `v2` is not protocol v2, which WebRTC rejects.

Explicit version overrides remain available; see [voice protocol](#native-voice-protocol).
Automatic retries pause after three consecutive short-lived failures and keep
the last cause visible. `r` retries the same launch settings; configuration edits
require quitting and relaunching.

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
profiles, and does not launch the TUI. `--allow-full-access` is still required at launch.

## Conversations and workspaces

One canonical workspace per launch: `--workspace` > an explicit
`orchestrator.workspace` in the config > launch cwd. Relative workspace paths
resolve from launch cwd; relative additional runtime roots resolve from that
workspace. Symlink paths canonicalize to the same directory.

Default launch lists native unarchived app-server history, newest-updated first,
and continues the latest non-ephemeral AgentVoice main conversation whose cwd
matches exactly. Legacy worker threads, child threads and other clients' threads are excluded.
If none exists, a new conversation starts. Lookup/resume failures are errors,
not an excuse to silently create a replacement. Explicit `--resume` must match
an eligible conversation in the selected workspace.

Fresh changes the conversation, not the workspace. It cuts the old media path
before opening the new one. Old native history is not deleted, and any native
work still active in the old conversation stays there. A per-thread kernel lock prevents two AgentVoice
launches from controlling the same conversation; other workspaces and explicit
fresh conversations can run independently.

Quitting stops voice and app-owned work, shuts down the child and restores the
terminal. **Work does not continue in the background.** The next launch can
resume saved native history, but there is no worker restart/adoption registry.
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
  All settings and prompt contents load once per launch; restart to apply edits.
- Per-launch opt-in debug logs; no phone remote, pairing, listener/discovery,
  Android packaging, separate Server, resident service or Herdr integration.

The upper field shows workspace, whether the conversation was started or continued,
and its native ID (truncated to fit). Model, effort and voice protocol reflect
Codex reports, not requested values; missing model data shows `unknown`. Identity
rows hide below 12 terminal rows. `LIVE` means the media link is connected, not
that Codex work completed. The most recent audio/transport or interaction notice
stays visible without `--debug`; detailed media tracing remains opt-in.

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
agentvoice --allow-full-access --workspace ~/code/myapp --model <model-id> --effort high
agentvoice --allow-full-access --fast
agentvoice --allow-full-access --resume <thread-id> --no-fast
agentvoice --allow-full-access --voice <voice-name> --device 1 --output-device 2
agentvoice --allow-full-access --config ./voice-settings.json --debug
```

Named CLI options beat the same named file settings. Raw native overrides merge
later: `orchestrator.extra.model` beats `--model`, an explicit
`orchestrator.config.model_reasoning_effort` beats `--effort`, and
`voice.extra.voice` beats `--voice`. `orchestrator.extra.config` replaces the
assembled request config as a whole. Fast flags are the explicit exception and
win over raw tier settings. Unset settings stay off the wire except the documented
full-access/never policy and WebRTC v3 compatibility default. Native app-server
defaults do not imply desktop-client parity. Restricted sandbox modes are not
supported by this app.

### Native startup settings

`--config` selects AgentVoice's JSON file. Repeatable `-c` / `--codex-config`
instead supplies **native Codex startup configuration**, just like Codex's own
`-c key=value`. No entries are supplied by default.

```sh
agentvoice --allow-full-access -c model_reasoning_effort=high
agentvoice --allow-full-access --codex-config 'shell_environment_policy.include_only=["PATH","HOME"]'
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

All AgentVoice settings, including `voice.name`, and prompt-file contents load
once at launch. Editing them requires quitting and relaunching; Fresh and redial
reuse the launch settings and do not restart Codex. Incompatible permission selectors and
disabled realtime support fail clearly; `cwd` must be selected with `--workspace`.
The full-access opt-in, native permission verification and owned stdio transport
remain mandatory. Other native keys remain passthrough, not a promise that your
Codex version supports them or detects typos. No global config, prompt or skill
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
share a voice-name family. This does not select the working model, reasoning
or Fast tier, or add prompt/startup-context/tail-flush overrides.

Explicit `prompt-files` voice-seed references and nonempty `voice.extra.initialItems`
require effective v3, which the normal WebRTC default satisfies. Even an empty
referenced seed file creates an item. Conflicting explicit protocols and WebRTC
v2 fail before Codex starts. Checks use the final merged request; an explicit
`initialItems: []` can still replace file seeds. Seeds are never silently dropped.

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

### Explicit prompt overrides

Nothing is loaded merely because it is named `VOICE.md` or `ORCHESTRATOR.md`.
With no `prompt-files` configuration, AgentVoice sends no file-based prompt
overrides. Existing unreferenced conventional files produce a visible migration
warning without reading their contents. No custom prompt files ship with the app.

For an intentional override, name the file in your chosen `server.json`:

```json
{
  "prompt-files": {
    "voice": "./my-voice.md",
    "orchestrator": "./my-work-instructions.md"
  }
}
```

This is an opt-in example, not baseline configuration. Filenames are arbitrary.
Relative paths resolve beside the selected config file, **not** the workspace;
absolute paths and leading `~/` are supported. Missing, unreadable, directory
or other non-file references fail before Codex starts, even if a raw field would
override the contents. An omitted reference sends nothing; a referenced empty
file sends an empty string. An empty path is an error, not an empty prompt.

| `prompt-files` key | Native field / effect | Former automatic filename |
| --- | --- | --- |
| `voice` | Realtime `prompt` | `VOICE.md` |
| `orchestrator` | Thread `developerInstructions` | `ORCHESTRATOR.md` |
| `orchestrator-base` | Thread `baseInstructions`: replaces the entire base prompt (visible warning) | `ORCHESTRATOR_BASE.md` |
| `orchestrator-session-start` | Realtime `realtimeStartInstructions` to the working agent | `ORCHESTRATOR_SESSION_START.md` |
| `orchestrator-session-end` | Realtime `realtimeEndInstructions` to the working agent | `ORCHESTRATOR_SESSION_END.md` |
| `voice-seed-developer` | Developer-role `initialItems` entry; effective v3 required (WebRTC default) | `VOICE_SEED_DEVELOPER.md` |
| `voice-seed-user` | User-role `initialItems` entry; effective v3 required (WebRTC default) | `VOICE_SEED_USER.md` |
| `voice-seed-assistant` | Assistant-role `initialItems` entry; effective v3 required (WebRTC default) | `VOICE_SEED_ASSISTANT.md` |

Contents load once at launch and are reused on redial and Fresh. Seed roles are sent developer, user, assistant; raw `initialItems`
can express any supported ordering/repetition. Session-boundary instructions and
voice prompts/items ride every realtime start, including redial. No transcripts
are captured and replayed by AgentVoice.

Migration: leave old files untouched or back them up, then explicitly reference
only the ones you want. For a native baseline, leave the section unset. The app
does not delete files or migrate configuration automatically. Removing an override
does not erase earlier instructions/messages from a resumed native conversation;
use `--no-continue` for a new conversation when testing the baseline. Native global
and workspace instructions, skills, MCPs and hooks still apply, even to Fresh.
AgentVoice does not automatically enable AgentStart skills or isolate native state.

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

### Native voice context: baseline first

All three controls below are configurable but **unset by default**. No setup is
needed: AgentVoice omits them and leaves native Codex behavior/configuration in
charge. The shipped `server.json.example` does not configure them. Continue,
explicit resume, redial and Fresh do not manufacture overrides.

A saved conversation is not the same as a voice call: redial starts another
call on the same conversation; Fresh starts a new conversation. Codex can give
each call a startup snapshot and can deliver leftover speech to the working
agent when a call ends. These are native mechanisms, not an AgentVoice replay
layer.

The following are **optional examples for later**, not recommended baseline
settings. Merge only the setting you want into your chosen config and relaunch;
these controls do not hot reload.

Skip the native startup snapshot for the voice model:

```json
{ "voice": { "include-startup-context": false } }
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

An explicit empty string for that override suppresses its text; it is not the
same as leaving the key out. `include-startup-context: false` skips both the
generated snapshot and any override. Neither control erases the working agent's
history or prevents later recall through delegation. A native snapshot may
include other threads, so workspace-local conversation selection is not memory
isolation.

Tail flush is independent of startup context: enabling it can start work at
hangup. Quitting AgentVoice still stops its child and does not wait for that work
to finish. Disabling tail flush does not suppress normal in-call delegations.

To return to native resolution, remove the relevant keys; do not substitute
`false` or `""`. Existing native settings can still apply. `voice.extra` wins over
the named voice controls, and `orchestrator.extra.config` replaces
`orchestrator.config` as a whole, so remove conflicting raw overrides too.

## Native work, no custom worker layer

Codex owns the voice-to-working-agent handoff, tools, subagents and their native
events. AgentVoice does not add worker tools, start extra worker threads, compose
completion reports, submit follow-up turns, or archive/delete completed work.
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
`thread-locks/` and `runs/<time>-<pid>.log` with
`--debug`. Lock files are inert after exit; the kernel owns their lifetime.
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
