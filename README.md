# AgentVoice

A foreground Codex voice app with a terminal UI. One AgentVoice process owns
the TUI, audio, WebRTC and coordination runtime; an unmodified `codex app-server`
child owns the agents, tools and native conversation history.

The direction is vanilla Codex with configurable prompts and settings.
Full access is an intentional product exception (see below). The defaults audit
is not finished: account balancing and remaining prompt/settings passthrough need review.

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
config key or remembered consent substitutes for the flag. Help and `accounts`
administration remain available without it.

This permits unrestricted command filesystem/network access with native
`danger-full-access` and approval policy `never`. Workspace selection does **not**
confine file access. AgentVoice verifies Codex's effective start/resume responses, including Fresh and
account rotation. Missing/restricted permission reports fail closed. Managed Codex
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

Installation is deliberately separate. `bun run setup` checks prerequisites
and builds audio; `bun run native:build` rebuilds it. The existing
`bun run cli:install` script installs dependencies, runs setup and links the
command. **AgentStart's current installer does not invoke AgentVoice**; wiring
that contract remains deferred. These commands do not install services.

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
  terminals, `m`, `s` and Space distinguish a quick tap (toggle) from a hold
  (temporarily unmute); terminals without release reporting use plain m/s
  toggles and leave Space inert.
- Redial renews voice on the same conversation using overlapping WebRTC peers;
  automatic renewal uses the same path. Fresh closes old media first.
- Device selection, model/effort/voice overrides, config/prompt passthrough,
  voice-name hot reload and optional account balancing.
- Per-launch opt-in debug logs; no phone remote, pairing, listener/discovery,
  Android packaging, separate Server, resident service or Herdr integration.

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

CLI options beat file values. Optional unset settings stay off the wire so Codex
can use its own defaults/configuration. The intentional permissions exception is
the mandatory full-access/never policy above. Restricted sandbox modes are not
supported by this app.

### Native voice protocol

Unconfigured `voice.version` is now omitted from `thread/realtime/start`.
This follows stock Codex's **WebRTC interface default**, not a promise to match
every Codex product UI. An offline validation probe against Codex 0.153.3 confirmed
that omission follows v1; upstream source selects it independently of the general
native realtime version config. AgentVoice does not hardcode that default.

To preserve the former explicit v3 choice, put this in your chosen server.json:

```json
{ "voice": { "version": "v3" } }
```

Changing protocols can change the native default speech model and behavior.
In Codex 0.153.3, omitted version on WebRTC also ignores the native configured
realtime voice; explicit AgentVoice `voice.name` / `--voice` still passes through.
Current v1 and v3 share the same voice-name family. No new prompt, seed or
startup-context/tail-flush policy is added by this change.

`VOICE_SEED_*.md` and nonempty `voice.extra.initialItems` require explicit v3.
Even a present-but-empty seed file creates an initial item. Incompatible seed
settings and WebRTC v2 fail locally before Codex starts; seeds are never silently
dropped and protocols are never automatically switched. Checks use the final
merged request: `voice.extra.version` wins, and an explicit `initialItems: []`
can still intentionally replace file seeds. Explicit v1/v3 remain configurable;
the raw transport escape hatch remains unchanged.

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

Fast checks the current child's paginated model catalog, including hidden models,
and rechecks after account rotation. Unknown/unsupported models or unavailable
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

### Prompt files

Prompt files are optional and live beside the config:

| File | Purpose |
| --- | --- |
| `VOICE.md` | Replace the native voice prompt |
| `ORCHESTRATOR.md` | Developer instructions for the working Codex agent |
| `ORCHESTRATOR_BASE.md` | Replace the entire Codex base prompt (sharp edge) |
| `ORCHESTRATOR_SESSION_START.md`, `ORCHESTRATOR_SESSION_END.md` | Native session-boundary instructions to the working agent |
| `VOICE_SEED_DEVELOPER.md`, `VOICE_SEED_USER.md`, `VOICE_SEED_ASSISTANT.md` | Explicit initial voice items, in that order; require explicit realtime v3 |

Absent files leave native behavior alone; present-but-empty files are sent as
empty strings. Files load once at app launch. Only `voice.name` hot reloads;
other configuration changes require relaunch. A resumed thread can retain
native persisted settings; start-only fields cannot be retroactively replaced.
Native global/workspace instructions, skills, MCPs and hooks remain discoverable.
AgentVoice does not automatically enable AgentStart skills.

The two request escape hatches are `orchestrator.extra` and `voice.extra`;
`orchestrator.config` carries native Codex config overrides. Extra values
usually win, but cannot replace conversation IDs, the selected workspace, or an
explicit launch Fast/standard selection; conflicting permission selectors error.
Unknown upstream fields may be silently ignored. Transport/output overrides
can break the media path; not every upstream feature has a matching TUI.

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

## Optional accounts

`accounts.balance: true` asks `agentusage balance codex`, with
`codex-swap select` fallback, for an account at launch and idle rotation.
`agentvoice accounts add <slug>` creates/logs in a profile;
`accounts list` lists profiles. Each profile has a distinct authentication
grant and shared native session/config state. Never copy rotating grants.
No rotation while voice or native turns are active.
Account selection remains opt-in.

## State and migration

Native conversation history stays in Codex's own store. AgentVoice state under
`$XDG_STATE_HOME/agentvoice` (default `~/.local/state/agentvoice`) contains
`thread-locks/`, optional `accounts/`, and `runs/<time>-<pid>.log` with
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
history, and closes—no turns or audio. `audio:probe` uses hardware;
`accounts:probe` may use real accounts/inference and is a separate explicit check.
See [AGENTS.md](AGENTS.md) for the source map and [ADR 0009](docs/adr/0009-one-foreground-workspace.md)
for the ownership decision.
