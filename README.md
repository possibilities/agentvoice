# AgentVoice

A foreground Codex voice app with a terminal UI. One AgentVoice process owns
the TUI, audio, WebRTC and coordination runtime; an unmodified `codex app-server`
child owns the agents, tools and native conversation history.

The direction is vanilla Codex with configurable prompts and settings.
Full access is an intentional product exception (see below). The defaults audit
is not finished: pinned realtime v3, optional workers and account balancing remain.

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
confine file access. Main conversations and optional workers use the same policy;
AgentVoice verifies Codex's effective start/resume responses, including Fresh and
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
matches exactly. Workers, child threads and other clients' threads are excluded.
If none exists, a new conversation starts. Lookup/resume failures are errors,
not an excuse to silently create a replacement. Explicit `--resume` must match
an eligible conversation in the selected workspace.

Fresh changes the conversation, not the workspace. It cuts the old media path
before opening the new one. Old native history is not deleted. Optional workers
already running still belong to their original parent, and never report into
the fresh conversation. A per-thread kernel lock prevents two AgentVoice
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
  voice-name hot reload, optional worker dispatch and account balancing.
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
can use its own configuration. Exceptions are the mandatory full-access/never
policy above and the retained realtime version `v3`. Restricted sandbox modes
are not supported by this app.

### Native Fast mode

`--fast` requests the working Codex model's advertised Fast tier: the same model
and reasoning settings, faster processing at higher usage/cost. It does not
change the realtime speech model, speech speed, prompts or voice context.
`--no-fast` explicitly requests standard processing. The flags conflict with
each other; omitting both preserves existing AgentVoice/native tier settings.

These are launch overrides, including for continued conversations, Fresh and
optional workers. They beat `orchestrator.service-tier`, native config overrides
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
| `VOICE_SEED_DEVELOPER.md`, `VOICE_SEED_USER.md`, `VOICE_SEED_ASSISTANT.md` | Explicit initial voice items, in that order |

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

Native voice startup-context and transcript-tail controls are retained unchanged,
not supplemented by an AgentVoice transcript replay layer. A native startup
snapshot may include other threads; turning it off does not erase Codex history.
Enabling tail flush can start work at hangup, but quitting this foreground app
still stops its child—it does not wait for such work to finish.

## Optional workers and accounts

`orchestrator.dispatch: true` declares `dispatch_worker`, `check_workers`
and `cancel_worker` on new main conversations. Workers inherit workspace and
execution settings, not prompt files or dispatch tools. Results are pull-only
unless `dispatch-reports: true` additionally submits a tagged report to their
original parent. Completed worker roots are archived with retries; native
history is preserved. Dynamic tools are native start-only/persisted metadata.

`accounts.balance: true` asks `agentusage balance codex`, with
`codex-swap select` fallback, for an account at launch and idle rotation.
`agentvoice accounts add <slug>` creates/logs in a profile;
`accounts list` lists profiles. Each profile has a distinct authentication
grant and shared native session/config state. Never copy rotating grants.
No rotation while voice, turns, workers, cleanup or reports are active.
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
