# AgentVoice crash kit

This archive preserves the last AgentVoice implementation and every live fleet
integration removed when it retired on 2026-08-29. It is meant for a future
agent designing a new voice system: start with the narrow seams below, reuse
the proven mechanics, and do not assume the old product boundary should return.

## Start here

- `../AGENTS.md` is the most compact architecture and invariant map.
- `../CONTEXT.md` is the product glossary. It distinguishes the Resident,
  App-server, Server, Console, Attachment, orchestrator agent, and voice agent.
- `../README.md` is the operator-facing system guide.
- `../docs/adr/` records the decisions that survived long enough to become
  architectural constraints.
- `removed-from-code/` contains path-preserving, pre-retirement snapshots of
  every file outside this repository from which AgentVoice material was
  removed. These are complete source files rather than excerpts, so no removed
  line or surrounding contract is lost.

## Bones worth picking

| Area | Entry points | What was learned |
| --- | --- | --- |
| Resident Codex transport | `../src/resident/`, `../src/core/attach.ts`, `../src/core/ws-frame.ts` | A launchd-owned App-server can retain threads across UI restarts. Unix transport is WebSocket-framed, partial writes must be drained, and attachment recovery must reconcile state rather than expect notification replay. |
| Realtime session semantics | `../src/core/session.ts`, `../tests/session.test.ts` | A replacement realtime session silently supersedes the old control plane while its media peer can linger. Redial and fresh-thread behavior therefore need separate state transitions. |
| Coordination runtime | `../src/core/runtime.ts`, `../src/core/workers.ts` | Persisted orchestrator and worker registries can survive Server restarts, but stranded tool calls require explicit interruption and reconciliation. |
| Account isolation | `../src/core/accounts.ts`, `../scripts/account-profiles-probe.ts` | OAuth refresh grants must never be copied between homes. Per-account homes can share rollout/config state through a carefully constrained symlink farm. |
| Control plane and pairing | `../src/server/`, `../docs/adr/0003-*`, `../docs/adr/0004-*`, `../docs/adr/0005-*` | Local owner-only control and authenticated remote control can share one protocol while keeping audio peer-to-peer and pairing keys individually revocable. |
| Duplex audio | `../src/console/duplex-audio.ts`, `../src/console/duplex-device.ts`, `../src/console/native/` | One native full-duplex device and explicit capture/playback rings avoid competing audio owners. |
| Terminal instrument | `../src/console/tui.ts`, `../src/tui/` | The signal field, touch zones, and command palette made voice state observable without turning the TUI into a settings dashboard. |
| Configuration contract | `../src/core/config-schema.ts`, `../server.schema.json`, `../scripts/generate-schema.ts` | Optional configuration remained distinguishable from defaults, and generated-schema drift was test-enforced. |
| Android remote | `../droidedtui.json`, `../android/`, `../src/android/` | The remote was a control peer, never an audio client; Android Keystore held device identity and DroidedTUI supplied the reusable terminal host. |
| Fleet integration | `removed-from-code/agentstart/`, `removed-from-code/agentguidance/`, `removed-from-code/agentsurface/` | AgentStart installed and configured it, Agentguidance rendered its orchestrator doctrine, and AgentSurface exposed the Remote console in Herdr. These copies show the complete former wiring. |

## Removed integration index

Every path below is relative to `removed-from-code/` and preserves the source
file exactly as it stood before retirement:

- `agentstart/`: `.github/workflows/ci.yml`, `AGENTS.md`, `CONTEXT.md`,
  `README.md`, `config/herdr/config.toml`,
  `config/resources/codex-plugin.json`,
  `docs/adr/0002-render-one-private-resource-set.md`,
  `prompts/agentvoice/server.json`, `scripts/install-agentvoice-cli`,
  `scripts/install.sh`, `site/public/fleet-resources.json`,
  `skills/fleet/MAP.md`, and `tests/validate.sh`.
- `agentguidance/`: `AGENTS.md`, `CONTEXT.md`,
  `prompts/agentvoice/ORCHESTRATOR.md`,
  `prompts/agentvoice/ORCHESTRATOR_SESSION_START.md`, `scripts/render`,
  `skills/story/references/testing.md`, and `tests/validate.sh`.
- `agentsurface/`: `AGENTS.md`, `README.md`,
  `plugin/herdr-plugin.toml`, `test/directive.test.ts`,
  `test/hook-log.test.ts`, and `test/tab-namer.test.ts`.
- `agentchats/`: `CONTEXT.md`, `README.md`, `test/cass.test.ts`,
  `test/config.test.ts`, and `test/overlay.test.ts`.
- `agentusage/`: `test/render.test.ts`.
- `droidedtui/`: `CONTEXT.md`,
  `android/app/src/test/java/com/possibilities/droidedtui/host/AndroidHostBridgeTest.java`,
  the generated `.droidedtui/` copy of that Java test (an ignored workspace
  snapshot rather than a file from the named Git revision),
  `packages/packager/test/manifest.test.ts`, and
  `packages/protocol/test/protocol.test.ts`.
- `funk/`: `AGENTS.md`, `tests/fixtures/bun`, and `tests/validate.sh`. Its
  repository-local Git metadata was not a tracked source file; the exact
  AgentVoice section removed from it is recorded below.
- `clispeak/`: `AGENTS.md`.

## Runtime retirement record

The repository-owned `server uninstall` and `resident uninstall` commands
booted out `com.agentvoice.server` and `com.agentvoice.resident` and removed
their LaunchAgent plists while deliberately leaving the state directory in
place. The three verified managed links
`~/.config/agentvoice/{ORCHESTRATOR.md,ORCHESTRATOR_SESSION_START.md,server.json}`
were removed. Independent configuration files in that directory and all
private runtime state were retained.

The editable Bun installation was also retired: its global `agentvoice`
command and package links were removed. Two banner-proven rendered prompt
artifacts were taken out of `~/.agents/prompts/agentvoice/`; their source
templates are preserved under `removed-from-code/agentguidance/`. The sole
Agentchats auxiliary-originator config entry named the retired producer, so
that live behavior-bearing config was reduced to an empty object.

Funk's repository-local `.git/config` carried this non-secret verification
hint. It was removed from the live checkout and is preserved here verbatim:

```ini
[agentvoice]
	verify = tests/validate.sh
```

The older native `AgentVoice.app` and `AgentVoice Dev.app` installation was a
build of commit `8456729e87af7d4f659470c968baabbe2a6ad0ef`, which remains in the
Git history of `~/archive/agentvoice-legacy`. Its already-unloaded resident was
stopped through the app's own control command, then both derived app bundles
and the rendered prompt artifacts were moved to the recoverable Trash folder
`~/.Trash/agentvoice-retirement-2026-08-29/`. They are not duplicated in this
repository because their exact source and prompt templates are already
preserved here and in the legacy archive.

## Pre-retirement revisions

| Repository | Revision |
| --- | --- |
| AgentVoice (directory was `agentvoice2`) | `5d6d51cb020bacc3b78ffe9c4acc54afb90c1391` |
| AgentStart | `fe045d88d4411e6524f93dc52fa7eeb366a9bb42` |
| Agentguidance | `32581ef2ee496ec8d7770b0871e5c77071ca97b2` |
| AgentSurface | `d278a35180bbdbb72d68c3a4add298e16d0d31c6` |
| Agentchats | `5910996ed817cc1127a4512c4d679df9d199363a` |
| Agentusage | `d2d23e463f570518aa4449a4293f0cb2fc3e73a1` |
| DroidedTUI | `4f919cf4e11556a05134d35e4278858f3976aec7` |
| Funk | `a78cd739987142db49af2c162c40e5a55f891733` |
| clispeak | `98e3aa56510878d64a48933ccd1559711bb29389` |

The sibling `~/archive/agentvoice-legacy` repository is an earlier, unrelated
AgentVoice architecture with its own Git history and remote. It was already in
the requested archive destination and was renamed rather than overwritten.

## What is deliberately absent

No machine-private state was copied. In particular, this kit excludes OAuth
grants, account profiles, Server identity keys, paired-device records, control
tokens, logs, sockets, and live configuration under `~/.local/state` or
`~/.config`. The source describes those formats without publishing their
contents.

Git history is the precise record of how the project evolved. The snapshots in
`removed-from-code/` are the complementary record of how the rest of the fleet
used it at the moment of retirement.
