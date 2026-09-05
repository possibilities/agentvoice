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
- `bun run generate:schema` — regenerate server.schema.json after schema edits.
- `scripts/install.sh --install` / `bun run cli:install` — same command-only
  editable installer, called by AgentStart. Requires explicit installation scope;
  never use the live destination to test. Installer tests use disposable checkouts,
  local-only dependencies, a fake compiler and a Codex invocation sentinel.

## Source map

- scripts/install.ts: clean checkout, frozen dependencies, staged native build,
  ownership-safe editable command publication and deployed-sha receipt. No launch,
  configuration, service, prompt/skill setup or legacy command cleanup.
- src/main.ts: foreground CLI, console alias, workspace canonicalization;
  former accounts/service/remote verbs error.
- src/paths.ts: config/state locations and tilde expansion.
- src/core/config-schema.ts: single source of truth for config keys and docs;
  strict outer objects, open config/extra passthroughs, optional means unset.
- src/core/config.ts: named CLI > file > default resolution and explicit prompt-files
  loading. Legacy filename checks only warn; never read unreferenced contents.
- src/core/codex-config.ts: ordered native startup overrides; validate only argv
  shape and product-invariant choices, never rewrite the forwarded strings.
- src/core/params.ts: pure config/prompts → native thread and realtime requests.
  Codex normally ignores unknown fields; do not promise errors on passthrough typos.
  Default effective WebRTC requests to v3 for compatibility after raw merging.
  Explicit versions/null and alternate transports win; never call this Codex's native default.
  Quiet resume adds one developer initial item on WebRTC v3 reconnects only;
  quiet-resume=false or explicit initial items (including seed files, []/null) win.
  Native startup context defaults false; explicit true/null passthrough still wins.
  Spoken history replay is a separate frontend behavior (default true); explicit
  initial items or replay-spoken-history=false skip automatic history reads/replay.
  Validate final merged seeds/version and WebRTC v2 conflicts before child startup.
- src/core/spoken-history.ts: selected-thread native speech reads only. Prefer
  timeline API; legacy -32601 falls back to the exact verified native JSONL path
  from thread/read. No file scan, separate ledger, history migration or rewriting.
  Bound recent speech and report limits/errors; obsolete reads cannot start calls.
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
- src/core/runtime.ts: launch/resume/Fresh, voice session, child lifecycle,
  launch-cached settings. No account selection/rotation, reattachment/restart adoption,
  custom worker manager, tool callback or submitted report/follow-up turns.
  Keep old main-thread locks until quit; native work may still be active there.
- src/core/session.ts: counted native voice starts/stops and attribution.
- src/console/host.ts: native readiness before audio opens, negotiation after audio
  readiness, visible media notices, direct in-process wiring and quit cleanup.
- src/console/transport.ts: WebRTC offer/answer, two-peer redial and renewal.
- src/console/duplex-audio.ts + duplex-device.ts + native/: in-process miniaudio
  capture/playback, Opus, bounded PCM rings. Detach clears stale playback.
- src/console/tui.ts + signal-field*.ts + src/tui/palette.ts: one full-height
  signal field, mute/PTT, palette; no peer mirroring.

## Ownership and state invariants

Public voice launches require --allow-full-access before config/child/media
startup, every time. No prompt or config/env bypass. Help is exempt;
retired commands report migration errors without launching.
Full access / never is an intentional product invariant for main conversations,
not a default to inherit or weaken. Confirm native start/resume responses on
launch and Fresh. Unexpected human interaction is refused
with a persistent TUI notice; never add automatic consent or invented answers.

Resolve one existing absolute real workspace before spawning the child:
CLI workspace > explicit file workspace > launch cwd. Use it for lookup,
thread start/resume; relative runtime roots use it too. Reject
conflicting cwd and identity escape hatches. This is selection, not filesystem
sandboxing or memory isolation.

Default continue uses native unarchived history, newest updated first, with
sourceKinds appServer plus vscode, all providers and exact cwd. Stock 0.153.3
classifies this third-party app-server client as vscode and can omit threadSource
from list rows, so verify candidate ownership with thread/read before selecting
agentvoice-orchestrator, no-parent, non-ephemeral history. Explicit resume must
be found in that inventory. Do not hide lookup/resume failures as Fresh.

Fresh cuts media before switching identity. Native work in an old main thread
stays there, even once a new conversation is active. Quitting ends voice and app-owned
work and closes the child. Old thread.json/workers.json and native history are
never rewritten, imported or removed. Per-thread locks allow independent launches;
an old background version or another client does not participate in that guard.

App state: thread-locks/ and opt-in unique runs/ logs under
~/.local/state/agentvoice ($XDG_STATE_HOME honored). Configuration/prompt paths
remain ~/.config/agentvoice/server.json and explicitly referenced prompt files. Inherit
CODEX_HOME unchanged (including omission); native Codex owns authentication,
credential storage/refresh, configuration and history. Never discover, create or
reconcile profile homes, read auth.json, invoke account tools/login, or replace
the child on quota events. Existing profile directories/links stay untouched.
Retired accounts configuration errors even if false/empty; no automatic migration.

Do not silently install, restart/uninstall old services, change global config,
edit archive checkouts or start inference/audio probes. Those require scope.

## Upstream realtime semantics

Baseline lifecycle verified against Codex 0.147 source + probes. Version/default
and invalid-combination checks refreshed against stock 0.153.3 with network denied,
an isolated disposable CODEX_HOME, and deliberately invalid requests; no live audio.
On September 5, 2026, a live startup check with stock 0.153.3 and the local native
login rejected omitted WebRTC version with invalid_quicksilver_alpha_header;
explicit v3 connected (no microphone/speaker). See README's compatibility note.
The operator confirmed the v3 launch works and approved restoring it as AgentVoice's
documented WebRTC compatibility default. This is not a new native app-server default.

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
   unreferenced vs. explicitly referenced with empty contents. A non-empty
   `experimental_realtime_ws_backend_prompt` in `~/.codex/config.toml` silently
   outranks the request `prompt`, and we cannot see it.
8. Thread and realtime params are serde-lenient: unknown fields are ignored,
   never rejected. A misspelled key in an `extra:` block fails silently, and
   `thread/resume` quietly drops start-only fields rather than erroring
   — hence `params.ts` filters known fields after the raw extra merge (0.153.3).
9. `initialItems` is realtime v3 only, capped at 128 items and 8,192 estimated
   text tokens. Require effective v3 for nonempty initial items (including empty
   seed-file text). AgentVoice supplies v3 for WebRTC when version is unset;
   explicit voice.extra.version:null still reaches native fallback. In Codex
   0.153.3, that fallback selects v1 independently of general realtime config and
   ignores the native configured voice. Explicit v3 honors that voice config.
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


## Conventions

- One root AGENTS.md; don't hide instructions in subtrees an agent won't load.
- Comments state constraints the code cannot show, not narration.
- Record<string, unknown> access uses bracket keys.
- The TUI is chromeless: full-bleed signal field with translucent status/meter
  overlays. Commands live in ctrl+k; direct keys work while it is closed and
  ctrl+c always falls through. M/S toggle on press; Space and pointer PTT are
  hold-only. OpenTUI 0.5.3 reports repeats as press + repeated; ignore them for
  toggles and renew only live Space holds. Palette opening cancels holds.
  No unrelated visual redesign during lifecycle cuts.
- All AgentVoice settings and prompt contents load once per launch. No voice-name
  watcher or local voice catalog; Codex validates voice selection. TUI model,
  effort and voice version are reported native values, never inferred from requests.
- server.schema.json is generated and drift-tested. server.json.example remains
  a verbatim-copy no-op. Unset fields are not sent, except explicit documented
  application defaults; do not imply the vanilla-defaults audit is complete.
  Keep protocol selection separate from prompt/model/context policy. An API fallback
  is not evidence of desktop parity. See the field guide's default comparison audit.
- codex-config is an optional string array; append repeatable -c/--codex-config
  CLI entries after file entries and pass each as a separate native -c argument
  after app-server. Never shell-evaluate, expand paths or log their values here.
  Native parses TOML, applies ordered dotted keys, and owns unknown-key behavior.
  Local interpretation is only for full-access and required realtime guards;
  effective thread permissions still must be confirmed. Startup values do not
  hot-reload or get copied into RPC config. Native request config can override
  startup entries; resumed model settings can outrank native startup defaults.
  The opt-in scripts/startup-config-probe.ts uses disposable state, network denial
  and ephemeral threads without turns/media to verify stock precedence on macOS.
- Prompt files require explicit prompt-files references; absent means no override.
  Paths resolve from the selected config directory, not the workspace. Preserve
  empty contents and final raw extra precedence; bad explicit references fail
  before native startup even when extra would replace their values. Contents load
  once per launch and are reused, never hot-reloaded or copied between sessions.
  Legacy names are metadata-only warnings, visible without debug; never silently
  delete/migrate user files. Removing overrides does not rewrite saved history or
  suppress native global/project instructions. Skill isolation is still separate.
- Do not manufacture skill policy or conversation summaries. The operator now
  authorizes replay of actual saved speech from the selected native thread (ADR
  0011), independently configurable with voice.replay-spoken-history=false.
  includeStartupContext defaults false on every call, including Fresh; explicit
  true enables the entire native snapshot, and raw null restores native resolution.
  Tail flush and experimental_realtime_ws_startup_context remain unset by default.
  Preserve explicit overrides; no user-config writes, forced tail-flush work,
  transcript database, or migration. Skill isolation remains a separate decision.
- Quiet resume is the documented exception to unmodified voice startup behavior:
  one developer initial item asks resumed/redialed v3 calls to wait for new input.
  Keep the native base prompt intact; no fabricated transcript, default tail-flush
  work or history rewriting. First call of Fresh has no replay or quiet instruction.
  A valid started notification marks later calls as reconnects; stale starts do not.
  See ADRs 0010/0011 for stock 0.153.3/0.153.4 and desktop 26.831.20005 evidence.
  Fake protocol tests do not establish live silence or audio-heard fidelity.
- No AgentVoice worker tools, registry, archival, reports, or custom turn
  submission. Native Codex tools, subagents and voice handoffs stay native.
  Retired dispatch/dispatch-reports config keys error, including explicit false.
  Saved custom tool calls receive an immediate failed tool result and visible
  retirement notice; never resurrect a handler or rewrite native history.
  Raw dynamicTools metadata passes on start only, with a visible warning and no
  client implementation. Unsupported client handoffs and media overrides also warn.

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
