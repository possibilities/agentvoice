# agentvoice — repository guidance

A foreground Codex voice TUI: one AgentVoice process owns UI, audio, WebRTC
and coordination; an owned stock Codex app-server child provides agents/tools
over native stdio. No background Server, resident, control attachment or remote
mode. Read README.md for usage, CONTEXT.md for vocabulary and ADR 0009 for
workspace/ownership rules. Historical ADRs describe former designs, not active
implementation.

## Commands

- `bun run test` — tests in tests/, fake protocol/media, no credentials or mic.
  Do not run bare `bun test`: it can discover dependency/vendor tests.
- `bun run typecheck` — strict TypeScript, no emit.
- `bun run lint` / `bun run format` — Biome checks / fixes.
- `bun run console --allow-full-access` — foreground TUI; needs Codex login and built native audio.
- `bun run native:build` / `bun run audio:probe` — build / exercise audio.
  The latter opens hardware; never substitute it for a no-microphone UI test.
- `bun run app-server:probe` — initialize and workspace-filtered list against
  an owned stock child, no turns/audio. Verify before Codex runtime upgrades.
- `bun run accounts:probe` — separate live account/profile/inference probe.
- `bun run generate:schema` — regenerate server.schema.json after schema edits.

## Source map

- src/main.ts: foreground CLI, console alias, workspace canonicalization;
  accounts subcommand remains separate. Former service/remote verbs error.
- src/paths.ts: config/state locations and tilde expansion.
- src/core/config-schema.ts: single source of truth for config keys and docs;
  strict outer objects, open config/extra passthroughs, optional means unset.
- src/core/config.ts: CLI > file > default resolution and prompt-file loading.
- src/core/params.ts: pure config/prompts → native thread and realtime requests.
  Codex normally ignores unknown fields; do not promise errors on passthrough typos.
  Omit unset voice.version; never replace it with an inferred native default.
  Validate final merged seeds/version and WebRTC v2 conflicts before child startup.
- src/core/full-access.ts: reject incompatible permission selectors and require
  effective dangerFullAccess/never on start/resume/settings reports. Never infer
  effective permissions from the request or bypass managed native requirements.
- src/core/service-tier.ts: launch-only Fast/standard override, per-child native
  catalog preflight, response checks and requested-versus-reported tier labels.
  No flag means no extra RPCs/overrides. --no-fast sends default, not omission;
  native off can report default or null (disabled Fast gate). Missing is unknown.
  The resume-model preflight mirrors upstream has_model_resume_override; reverify
  when upgrading Codex. Never switch models to satisfy Fast.
- src/core/attach.ts: owned child, native UTF-8 JSONL framing, correlated RPC,
  notifications, visible refusal callback, native denial payloads or JSON-RPC
  errors for unsupported human input, bounded shutdown of its process group.
- src/core/thread-selection.ts: paginated native history lookup in exact workspace,
  AgentVoice main source only; no global pointer or separate session index.
- src/core/thread-lock.ts: per-thread flock; keep lock inodes, release via close.
- src/core/runtime.ts: launch/resume/Fresh, session and per-parent worker managers,
  child lifecycle, idle account rotation, config watcher. No reattachment/restart
  adoption. Keep old parent identity/locks while workers can still report there.
- src/core/session.ts: counted native voice starts/stops and attribution.
- src/core/workers.ts: optional dynamic dispatch/check/cancel, report composition,
  archival retries. In-memory per-parent state only, disposed on quit.
- src/core/accounts.ts: optional balancer selection, account-profile symlink farm,
  distinct login grants and native shared history; no launchctl.
- src/console/host.ts: direct in-process runtime/media/TUI wiring and quit cleanup.
- src/console/transport.ts: WebRTC offer/answer, two-peer redial and renewal.
- src/console/duplex-audio.ts + duplex-device.ts + native/: in-process miniaudio
  capture/playback, Opus, bounded PCM rings. Detach clears stale playback.
- src/console/tui.ts + signal-field*.ts + src/tui/palette.ts: one full-height
  signal field, mute/PTT, palette; no peer mirroring.

## Ownership and state invariants

Public voice launches require --allow-full-access before config/child/media
startup, every time. No prompt or config/env bypass. Help/accounts are exempt.
Full access / never is an intentional product invariant for main and workers,
not a default to inherit or weaken. Confirm native start/resume responses on
launch, Fresh, rotation and workers. Unexpected human interaction is refused
with a persistent TUI notice; never add automatic consent or invented answers.

Resolve one existing absolute real workspace before spawning the child:
CLI workspace > explicit file workspace > launch cwd. Use it for lookup,
thread start/resume and workers; relative runtime roots use it too. Reject
conflicting cwd and identity escape hatches. This is selection, not filesystem
sandboxing or memory isolation.

Default continue uses native unarchived history, newest updated first, with
sourceKinds appServer (the upstream default excludes it), all providers, exact cwd,
agentvoice-orchestrator source, no parent and non-ephemeral. Explicit resume
must be found in that inventory. Do not hide lookup/resume failures as Fresh.

Fresh cuts media before switching identity. Keep workers tied to their original
parent, even once a new conversation is active. Quitting ends voice and app-owned
work and closes the child. Old thread.json/workers.json and native history are
never rewritten, imported or removed. Per-thread locks allow independent launches;
an old background version or another client does not participate in that guard.

App state: thread-locks/, optional accounts/, and opt-in unique runs/ logs under
~/.local/state/agentvoice ($XDG_STATE_HOME honored). Configuration/prompt paths
remain ~/.config/agentvoice/server.json and adjacent markdown files. Account
profile homes keep independent auth.json and share canonical native state.

Do not silently install, restart/uninstall old services, change global config,
edit archive checkouts or start inference/audio probes. Those require scope.

## Upstream realtime semantics

Baseline lifecycle verified against Codex 0.147 source + probes. Version/default
and invalid-combination checks refreshed against stock 0.153.3 with network denied,
an isolated disposable CODEX_HOME, and deliberately invalid requests; no live audio.

These invariants are load-bearing for `session.ts`; re-verify them before
bumping the supported codex version (`codex-rs/core/src/realtime_conversation.rs`,
`codex-rs/app-server/src/request_processors/turn_processor.rs`):

1. Three gates make the realtime surface work at all: spawn with
   `--enable realtime_conversation`, declare `experimentalApi: true` in
   `initialize`, and pass an explicit webrtc transport to
   `thread/realtime/start`.
2. app-server manages **one** realtime session per thread. A new start
   **supersedes** the previous session silently — no `closed` notification is
   emitted for it (renewal therefore never sends a stop).
3. `thread/realtime/stop` takes only `threadId` and always emits **exactly
   one** `closed(reason:"requested")`, even when no session exists. Ops on a
   thread are processed serially, so a stop issued after a start always lands
   after it.
4. `started` echoes the `realtimeSessionId` we chose; `closed` and `error`
   carry no session id. Natural end is `closed("transport_closed")`; failures
   emit `error` and then `closed("error")`.
5. A superseded session's WebRTC media path is not torn down promptly — the
   old peer lingers with a dead control plane. Clients must close it themselves
   (the console does, when the successor connects).
6. Priming is split across both calls, and not along agent lines. The
   orchestrator agent takes `baseInstructions` / `developerInstructions` on
   `thread/start`; the voice agent takes `prompt` on `thread/realtime/start`.
   But `realtimeStartInstructions` / `realtimeEndInstructions` also ride on the
   realtime call while being developer messages to the *orchestrator* — and
   they are therefore re-sent on every redial.
7. `prompt` is a double-option upstream: omitted keeps codex's built-in
   `backend_prompt.md`, while both `null` and `""` yield an empty prompt
   (`codex-rs/core/src/realtime_prompt.rs`). Prompt files encode that as
   absent vs. present-but-empty. A non-empty
   `experimental_realtime_ws_backend_prompt` in `~/.codex/config.toml` silently
   outranks the request `prompt`, and we cannot see it.
8. Thread and realtime params are serde-lenient: unknown fields are ignored,
   never rejected. A misspelled key in an `extra:` block fails silently, and
   `thread/resume` quietly drops the 12 start-only fields rather than erroring
   — hence `params.ts` filters them itself.
9. `initialItems` is realtime v3 only, capped at 128 items and 8,192 estimated
   text tokens. Require explicit v3 for nonempty initial items (including empty
   seed-file text). Unset voice.version is omitted. In Codex 0.153.3, WebRTC
   omission selects v1 independently of general realtime config and ignores
   the native configured voice, but still honors an explicit request voice.
   WebRTC rejects v2; v1 and v3 use the same voice-name family. Do not infer
   that this transport default matches every Codex product UI.
10. The webrtc transport is load-bearing for auth, not just media: the
    websocket transport hard-requires an API key (`realtime_api_key`,
    `realtime_conversation.rs`), while webrtc authorizes the SDP POST and the
    sideband WebSocket with the ModelClient's ordinary bearer — which is what
    makes a ChatGPT login work here at all. The call URL derives from the
    session's model provider (`client.rs`, `REALTIME_CALLS_ENDPOINT`), so any
    provider-swapping wrapper (e.g. a localhost credential proxy) silently
    breaks realtime even when threads still work.
11. ChatGPT refresh tokens rotate with server-side reuse detection
    (`login/src/auth/manager.rs`, `refresh_token_reused`): exactly one party
    may ever refresh a grant. Account profiles therefore hold their own
    grant's `auth.json` and codex alone refreshes it — never copy credentials
    between stores. Cross-profile resume and grant coexistence are re-verified
    by `bun run accounts:probe`.


## Conventions

- One root AGENTS.md; don't hide instructions in subtrees an agent won't load.
- Comments state constraints the code cannot show, not narration.
- Record<string, unknown> access uses bracket keys.
- The TUI is chromeless: full-bleed signal field with translucent status/meter
  overlays. Commands live in ctrl+k; direct keys work while it is closed and
  ctrl+c always falls through. No unrelated visual redesign during lifecycle cuts.
- server.schema.json is generated and drift-tested. server.json.example remains
  a verbatim-copy no-op. Unset fields are not sent, except explicit documented
  application defaults; do not imply the vanilla-defaults audit is complete.
- Do not manufacture skill policy, transcript replay or session carryover.
  Native voice-context controls remain configurable but unset by default:
  includeStartupContext, flushTranscriptTailOnSessionEnd and the native
  experimental_realtime_ws_startup_context override. Preserve omission and
  explicit false/empty values through continue, resume, redial and Fresh.
  Do not seed these into user config or server.json.example. Skill isolation
  remains a separate decision. Optional dispatch/account behavior stays opt-in.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, Codex uses
  `$agent:<name>`, and Pi uses `/<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
