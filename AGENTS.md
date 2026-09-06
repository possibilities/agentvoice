# agentvoice — repository guidance

A foreground Codex voice TUI: a retained controller owns UI, exact thread
identity, leases, control transports, and operation records; its disposable
runtime child owns audio, WebRTC, runtime code, config/prompt/role loading, and
an owned stock Codex app-server child over private native WebSocket. Local stock
TUI attachment is always available through a guarded gateway (ADR 0022).
No background Server,
resident, remote mode, or arbitrary control attachment. Read README.md for
usage, CONTEXT.md for vocabulary, and ADRs 0015/0022 for the active topology.

## What vanilla Codex means

The default reference is the Codex client-and-server experience, including both
the voice frontend and working agent. AgentVoice replaces the frontend, so
matching that experience can require sending values that Codex's own client
sends. An explicit request field is not by itself an AgentVoice customization;
omitting it is not by itself vanilla behavior.

When auditing a default, trace the relevant Codex client's selection and the
app-server's resolution separately. Record versions, transport and any feature
gate or remote-config uncertainty; do not infer the active rollout from a
reachable source branch. Identify client parity, server fallback and deliberate
AgentVoice policy separately. New departures from that baseline need an explicit
product decision or operator configuration. Existing product policies remain
in effect until individually changed; this principle does not silently replace
them, clone all desktop internals or revive retired features.

For desktop voice choices, inspect the JavaScript bundled in the installed
app's `Contents/Resources/app.asar` alongside the public Codex server source.
The frontend assets may be minified/generated JavaScript; they are not a
desktop TypeScript source checkout in the CLI repo. Retain exact asset names
and bounded excerpts so client-default findings can be rechecked after updates.

Realtime v3 is the concrete example: the inspected desktop's client-owned-call
path explicitly selects it, while omitted WebRTC version on stock app-server
0.153.4 selects v1. Do not label v3 non-vanilla merely because it differs from
that server fallback. See ADR 0019 and the field guide's default comparison audit.

## Commands

- `bun run test` — tests in tests/, fake protocol/media, no credentials or mic.
  Do not run bare `bun test`: it can discover dependency/vendor tests.
- `bun run typecheck` — strict TypeScript, no emit.
- `bun run lint` / `bun run format` — Biome checks / fixes.
- `bun run console` — foreground TUI; needs Codex login and built native audio.
- `bun run native:build` / `bun run audio:probe` — build / exercise audio.
  The latter opens hardware; never substitute it for a no-microphone UI test.
- `bun run app-server:probe` — initialize and workspace-filtered list against
  an owned stock child, no turns/audio. Verify before Codex runtime upgrades.
- `bun run generate:schema` — regenerate server.schema.json after schema edits.
- `bun run generate:events-schema` — regenerate the repo-local events.schema.json
  contract and named event catalog; keep its drift and socket-frame tests passing.
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
- src/core/config.ts: named CLI > file > default resolution and convention prompt
  files beside the selected config (PROMPT_FILES, one native control each; override
  plus append for one agent errors). Legacy filename checks only warn, never read.
- src/core/role.ts: role resolution (name under $AGENTROLES_HOME, else path), mcp.json
  translation to Codex fields, skills root discovery. Prompt mapping lives in config.ts:
  SYSTEM_PROMPT/APPEND_SYSTEM_PROMPT are the general orchestrator files; the
  VOICE_ORCHESTRATOR pair stands in for the same kind. Role skills go to the owned
  child via skills/extraRoots/set after initialize (process-local, verified on stock
  0.153.4); role MCP servers ride per-thread config. Never write under CODEX_HOME.
- src/core/codex-config.ts: ordered native startup overrides; validate only argv
  shape and product-invariant choices, never rewrite the forwarded strings.
- src/core/params.ts: pure config/prompts → native thread and realtime requests.
  Codex normally ignores unknown fields; do not promise errors on passthrough typos.
  Default effective WebRTC requests to v3 for compatibility after raw merging.
  Explicit versions/null and alternate transports win. Distinguish Codex client
  selection from app-server omission; v3 aligns with the desktop path noted above.
  No automatic speech-history reads, initial items or reconnect instructions.
  quiet-resume and replay-spoken-history are retired; their config keys error.
  AgentVoice leaves native startup context unset; explicit true/false/null
  passthrough and raw initialItems ([]/null included) still win.
  VOICE_AGENT_APPEND_SYSTEM_PROMPT.md owns the startup-context slot: it sends
  includeStartupContext true plus experimental_realtime_ws_startup_context in
  thread config; any other owner of that slot is a launch error, never a merge.
  Validate final merged initial items/version and WebRTC v2 conflicts before child startup.
- src/core/full-access.ts: explicit full-access flag overrides native permission
  selectors only; absent flag leaves native/configured modes intact. Never infer
  effective permissions from the request or bypass managed native requirements.
- src/core/service-tier.ts: launch-only Fast/standard override, per-child native
  catalog preflight, response checks and requested-versus-reported tier labels.
  No flag means no extra RPCs/overrides. --no-fast sends default, not omission;
  native off can report default or null (disabled Fast gate). Missing is unknown.
  The resume-model preflight mirrors upstream has_model_resume_override; reverify
  when upgrading Codex. Never switch models to satisfy Fast.
- src/core/attach.ts: owned child, native WebSocket RPC, notifications, visible
  interaction/refusal callbacks and bounded shutdown of its process group. Human
  requests recognized by human-input.ts remain pending in native Codex; never
  auto-answer or retain a second approval queue. Unsupported client requests
  receive native denial payloads or JSON-RPC errors; retired tools stay retired.
- src/core/native-listener.ts + src/attachment/: always-on private authenticated
  native loopback listener, exact-thread policy gateway, controller bootstrap and
  stock TUI launcher. No stdio RPC or attachment enable/disable flags. Never expose
  the native credential or allow other-thread/config/account mutations. Forward
  selected-thread native human requests and their correlated answers. Native owns
  first-answer resolution and pending-request replay on resume. Joining strips
  local TUI resume overrides to preserve live settings; subsequent native settings
  changes, including permissions, are allowed. Do not gate attachment on full access.
  Validate before native dispatch; unknown null placeholders are stripped.
  Watcher revocation terminates the TUI before automatic reconnect can replay input.
  Fresh/restart/quit revoke before teardown; redial preserves attachment. Ordinary
  acknowledged unsubscribe permits clean stock TUI exit without a WS close handshake.
- src/core/thread-selection.ts: paginated native history lookup in exact workspace,
  AgentVoice main source only; no global pointer or separate session index.
- src/core/thread-lock.ts: per-thread flock; keep lock inodes, release via close.
- src/runtime-control/controller.ts: retained foreground controller, exact
  thread leases, operation journal, controller/runtime generations and TUI.
  Optional restart handoffs are journaled before teardown and submitted once
  after exact resume and live media. Keep handoff outcome separate from runtime
  readiness; never stop healthy media on a handoff refusal or ambiguous result.
- src/runtime-control/process.ts + worker.ts + protocol.ts: private bounded
  controller/worker IPC. No audio/RTP/PCM or bearer capabilities in UI events.
- src/runtime-control/sender.ts: bounded worker writes; drop transient voice events
  at the soft limit without replacing deltas or failing healthy media.
- src/runtime-control/journal.ts: fsynced controller-lifetime operation records.
  Never adopt an old journal across a full quit/relaunch.
- src/events/: controller-owned read-only socket with prefix subscriptions,
  sequence-watermarked lifecycle snapshots, and transient native voice items/deltas.
  No transcript state, persistence, replay, backfill, or UI. Never discard voice
  events using lifecycle snapshot watermarks or infer missing native identity.
  No audio/bearer capabilities or mutation/MCP methods. Runtime replacements reset
  inventory; stale incarnations never publish into a successor. See docs/events.md.
- src/core/thread-observer.ts: bounded owned-child loaded inventory and metadata reads,
  never history hydration, resume, or turns. Preserve newer notifications over late reads.
- src/ipc/json-socket.ts: shared private NDJSON framing, ownership and bounded writes
  for both Unix endpoints. Never remove another listener or an unrelated file.
- src/control/: shared Zod contract/dispatch, private UDS NDJSON server,
  loopback Streamable HTTP MCP projection, and private live-controller discovery
  for the explicit `mcp-config` export and local attachment bootstrap. Keep the
  MCP and Unix control operations semantically identical.
- src/core/runtime.ts: a voice runtime's launch/resume/Fresh, voice session,
  child lifecycle, and runtime-cached settings. No account selection/rotation,
  reattachment/restart adoption, custom worker manager, tool callback or
  submitted report/follow-up turns, except the explicit controller-owned restart
  handoff through native turn/start (ADR 0016). Keep old main-thread locks until quit;
  native work may still be active there.
- src/core/session.ts: counted native voice starts/stops and attribution.
  Stop timeouts do not prove non-delivery: retain each expected requested-close
  until notification or reset; a late refusal must remove only its own stop.
- src/console/host.ts: native readiness before audio opens, negotiation after audio
  readiness, visible media notices, worker-local media wiring and quit cleanup.
- src/console/transport.ts: WebRTC offer/answer, two-peer redial and renewal.
- src/console/duplex-audio.ts + duplex-device.ts + native/: in-process miniaudio
  capture/playback, Opus, bounded PCM rings. Detach clears stale playback.
- src/console/tui.ts + signal-field*.ts + src/tui/palette.ts: one full-height
  signal field, mute/PTT, palette; no peer mirroring.

## Ownership and state invariants

Public voice launches support native/configured permissions without a flag.
--allow-full-access explicitly requests danger-full-access/never; it wins over
conflicting permission selectors, not unrelated settings. Do not reject launch,
Fresh, resume or settings reports solely because permissions are restricted or
unreported. Preserve native managed requirements. Command/file/permission approvals,
tool questions and MCP elicitations flow through an attached stock TUI. The voice
console shows an interaction notice; without a TUI, native Codex retains the request and
replays it on attachment. Never add automatic consent, refusals that race the TUI,
invented answers or an AgentVoice approval queue. Unsupported client tools/auth/
legacy/unknown requests are still refused visibly. See ADRs 0020/0022.

Resolve one existing absolute real workspace before spawning the child:
CLI workspace > explicit file workspace > launch cwd. Use it for lookup,
thread start/resume; relative runtime roots use it too. Reject
conflicting cwd and identity escape hatches. This is selection, not filesystem
sandboxing or memory isolation.

Ordinary launch creates a new conversation without resume-selection history
lookup. Explicit --continue uses native unarchived history, newest updated first, with
sourceKinds appServer plus vscode, all providers and exact cwd. Stock 0.153.3
classifies this third-party app-server client as vscode and can omit threadSource
from list rows, so verify candidate ownership with thread/read before selecting
agentvoice-orchestrator, no-parent, non-ephemeral history. Explicit resume must
be found in that inventory. Do not hide lookup/resume failures as Fresh.

Fresh cuts media before switching identity. Native work in an old main thread
stays there, even once a new conversation is active. Quitting ends voice and app-owned
work and closes the child. Old thread.json/workers.json and native history are
never rewritten, imported or removed. The controller retains every acquired
thread lease until quit, including old Fresh threads. Per-thread locks allow
independent launches; an old background version or another client does not
participate in that guard.

App state: thread-locks/ and opt-in unique runs/ logs under
~/.local/state/agentvoice ($XDG_STATE_HOME honored). Configuration/prompt paths
remain ~/.config/agentvoice/server.json and convention prompt files beside it. Inherit
CODEX_HOME unchanged (including omission); native Codex owns authentication,
credential storage/refresh, configuration and history. Never discover, create or
reconcile profile homes, read auth.json, invoke account tools/login, or replace
the child on quota events. Existing profile directories/links stay untouched.
Retired accounts configuration errors even if false/empty; no automatic migration.

Live controllers also own atomic mode-0600 transport descriptors below the
mode-0700 control directory. They may contain the bearer capability for the
explicit `agentvoice mcp-config` export and local `attach` bootstrap, are removed on normal close, and must be
selected through a bounded live UDS status check by exact canonical workspace
and optional thread. Never put the token in status or diagnostics, trust mutable
identity from the descriptor, choose the newest ambiguous controller, or clean
up an unowned stale record while reading.

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
documented WebRTC compatibility default. Desktop inspection on September 6 also
confirmed explicit v3 selection on its client-owned-call path; this is client
alignment, while the app-server's omitted-version fallback remains v1.

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
   absent vs. present with empty contents. A non-empty
   `experimental_realtime_ws_backend_prompt` in `~/.codex/config.toml` silently
   outranks the request `prompt`, and we cannot see it. There is no native
   append field: with includeStartupContext true, Codex renders `prompt`, a
   blank line, then `experimental_realtime_ws_startup_context` (or its Recent
   Work snapshot when that key is unset) — the only literal suffix path.
8. Thread and realtime params are serde-lenient: unknown fields are ignored,
   never rejected. A misspelled key in an `extra:` block fails silently, and
   `thread/resume` quietly drops start-only fields rather than erroring
   — hence `params.ts` filters known fields after the raw extra merge (0.153.3).
9. `initialItems` is realtime v3 only, capped at 128 items and 8,192 estimated
   text tokens. Require effective v3 for nonempty initial items. AgentVoice
   supplies v3 for WebRTC when version is unset;
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
- All AgentVoice settings and prompt contents load once per runtime generation. No voice-name
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
  Local interpretation covers explicit full-access overrides and required realtime
  guards. Preserve unrelated values verbatim. Startup values do not
  hot-reload or get copied into RPC config. Native request config can override
  startup entries; resumed model settings can outrank native startup defaults.
  The opt-in scripts/startup-config-probe.ts uses disposable state, network denial
  and ephemeral threads without turns/media to verify stock precedence on macOS.
- Prompt files are convention names in the selected config directory, not the
  workspace; absent means no override. Each name is one native control; do not add
  AgentVoice-shaped prompt overlays (the seed files were removed for that reason).
  Preserve empty contents and final raw extra precedence; a present name that
  cannot load fails before native startup even when extra would replace its value.
  Contents load once per runtime generation and are reused until explicit runtime
  replacement, never watched or copied
  between sessions. Legacy names and the retired prompt-files key are metadata-only
  warnings/errors, visible without debug; never silently delete/migrate user files.
  Removing overrides does not rewrite saved history or suppress native
  global/project instructions. A role directory replaces the config directory as
  the prompt source for its launch; config-directory files then warn, never merge.
- Do not manufacture skill policy, conversation summaries or speech-history
  replay. ADR 0017 removes the automatic replay layer and its configuration.
  includeStartupContext stays omitted on every call unless explicitly configured;
  native server resolution currently includes its snapshot. Explicit false skips
  it, true requests it, and raw null restores native resolution (ADR 0020).
  Tail flush and experimental_realtime_ws_startup_context remain unset by default
  unless VOICE_AGENT_APPEND_SYSTEM_PROMPT.md claims the latter (ADR 0013).
  Preserve explicit overrides; no user-config writes, forced tail-flush work,
  transcript database, or migration. Role skills are the only skill isolation:
  extra roots on the owned child, no global skills.config or plugin changes.
- Ordinary reconnects carry no AgentVoice-authored instruction or automatic
  initial items. Keep the native base prompt intact and preserve explicit native
  context/prompt overrides; no default tail-flush work or history rewriting.
  Native thread resume remains independent of new voice-call context.
  See ADR 0017 for the removal decision and ADRs 0010/0011 for historical probes.
  Fake protocol tests do not establish live silence or audio-heard fidelity.
- No AgentVoice worker tools, registry, archival, reports, or custom turn
  submission except a caller-supplied restart handoff (ADR 0016). Submit that
  handoff once through native turn/start after the controller verifies exact
  identity and live media. Do not change either agent's prompt defaults, retry
  ambiguous acceptance, echo the private prompt in status/errors, or assume a
  clientUserMessageId guarantees native deduplication. Native Codex tools,
  subagents and voice handoffs stay native.
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
