# agentvoice — repository guidance

A local Codex voice server and separate pointer-only TUI. `agentvoice server`
waits on a private workspace socket without opening audio or Codex; `agentvoice client`
connects and starts a call. Bare `agentvoice` composes that client, voice transcript,
and stock agent attachment in one foreground smolmux process with local PTYs only.
The server-owned call controller retains exact thread
identity, leases, operation journal and control/event transports; its disposable runtime
owns audio, WebRTC, config/prompt/role loading and an owned stock Codex app-server.
Frontend disconnect closes the call before another can begin. The macOS installer supervises the waiting default server as a user LaunchAgent.
No remote mode or arbitrary endpoint attachment. Read README.md, CONTEXT.md and ADRs
0024/0022 for the active topology; ADRs 0015/0016 describe retained MCP/API
runtime replacement and restart handoff semantics.

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
- `bun run server` — waiting foreground server; calls need Codex login and built native audio.
- `bun run console` — independent pointer frontend; connects to the workspace server.
- `bun run native:build` / `bun run audio:probe` — build / exercise audio.
  The latter opens hardware; never substitute it for a no-microphone UI test.
- `bun run app-server:probe` — initialize and workspace-filtered list against
  an owned stock child, no turns/audio. Verify before Codex runtime upgrades.
- `bun run generate:schema` — regenerate server.schema.json after schema edits.
- `bun run generate:events-schema` — regenerate the repo-local events.schema.json
  contract and named event catalog; keep its drift and socket-frame tests passing.
- `scripts/install.sh --install` / `bun run cli:install` — same editable command and macOS LaunchAgent
  installer, called by AgentStart. Requires explicit installation scope;
  never use the live destination to test. Installer tests use disposable checkouts,
  local-only dependencies, a fake compiler, a fake launchctl runner and a Codex invocation sentinel.
  Use --command-only for command publication fixtures; never run live launchctl in tests.

## Source map

- scripts/install.ts: clean checkout, frozen dependencies, staged native build,
  ownership-safe editable command publication and deployed-sha receipt, followed by
  default LaunchAgent installation on macOS. --command-only skips service management.
  No configuration, prompt/skill setup or legacy command cleanup.
- src/service.ts: owned user LaunchAgent install/status/restart/remove, explicit argv
  and selected environment, private logs, bounded launchctl and failed-install rollback.
  Never adopt an unrelated loaded job or edited/unsafe plist, or open audio as a check.
- src/workspace.ts: default/workspaces generations under XDG state; newest sortable
  timestamp-and-UUID name wins, independent of mtimes. Initial creation is atomic;
  reject unsafe selected directories. No reset/deletion or context-policy changes.
- src/main.ts: server/frontend CLI and workspace canonicalization; former
  accounts/resident/remote/console verbs error.
- src/frontend/: strict private workspace socket, exclusive call ownership and
  minimal state/input protocol. Disconnect releases PTT and stops the call; never
  accept a successor until cleanup completes or automatically reconnect/replay.
  Fresh clients observe explicit closing state and wait at most 30 seconds before
  requesting a call; observation never reserves admission. Connected and unavailable
  states fail immediately. The composition shares this client readiness handling.
- src/composition/: bare-command foreground smolmux launcher and three-pane layout.
  All apps use local PTYs, never Companion ownership; shutdown reaps the exact
  foreground child. Read-only frontend observation gates attachments on this
  client's correlation ID, live media and exact workspace/thread. Correlation is
  not authorization. Observer disconnect cannot close a call or send input.
  Preserve divider revisions. Any pane app exiting or failing ends the entire
  composition and call, including attachment revocation during runtime restart;
  never automatically relaunch attachments or open audio/inference in composition tests.
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
  VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md owns native multi-agent mode plus V2
  enablement on start/resume. The default role carries it; other roles inherit
  native policy. Preserve unrelated V2 settings; duplicate mode owners, disabled
  V2 and raw config replacement that drops the file are launch errors.
  Codex normally ignores unknown fields; do not promise errors on passthrough typos.
  Default effective WebRTC requests to v3 for compatibility after raw merging.
  Explicit versions/null and alternate transports win. Distinguish Codex client
  selection from app-server omission; v3 aligns with the desktop path noted above.
  No automatic speech-history reads, initial items or reconnect instructions.
  quiet-resume and replay-spoken-history are retired; their config keys error.
  AgentVoice defaults includeStartupContext to false at the request boundary on
  every call, matching the desktop client; app-server omission instead means true.
  See ADR 0029 before changing this default. Explicit true/false/null passthrough
  and raw initialItems ([]/null included) still win.
  VOICE_AGENT_APPEND_SYSTEM_PROMPT.md owns the startup-context slot: it sends
  includeStartupContext true plus experimental_realtime_ws_startup_context in
  thread config; any other owner of that slot is a launch error, never a merge.
  Validate final merged initial items/version and WebRTC v2 conflicts before child startup.
- src/core/full-access.ts: explicit full-access flag overrides native permission
  selectors only; absent flag leaves native/configured modes intact. Never infer
  effective permissions from the request or bypass managed native requirements.
- src/core/service-tier.ts: launch-only Fast/standard override, per-child native
  catalog preflight, response checks and requested-versus-reported tier metadata.
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
  native loopback listener, root-and-verified-descendant policy gateway, controller bootstrap and
  stock TUI launcher. No stdio RPC or attachment enable/disable flags. Never expose
  the native credential or allow unrelated-thread/config/account mutations. Verify native
  parentThreadId ancestry and exact workspace before descendant dispatch; never infer
  authorization from a tool message, forkedFromId or a client-supplied parent. Forward
  root/descendant native human requests and their correlated answers. Native owns
  first-answer resolution and pending-request replay on resume. Joining strips
  local TUI resume overrides to preserve live settings; subsequent native settings
  changes, including permissions, are allowed. Do not gate attachment on full access.
  scripts/voice-speak.ts uses the same gateway with exact-root admission for explicit
  root-only thread/realtime/appendSpeech (nonempty text, 64 KiB maximum); other realtime
  mutations remain denied. Never retry speech automatically or report acceptance
  as playback confirmation.
  Validate before native dispatch; unknown null placeholders are stripped.
  Watcher revocation terminates the TUI before automatic reconnect can replay input.
  Runtime restart and call shutdown revoke before teardown; redial and automatic
  renewal preserve attachment. Ordinary
  acknowledged unsubscribe permits clean stock TUI exit without a WS close handshake.
- src/core/thread-selection.ts: paginated native history lookup in exact workspace,
  AgentVoice main source only; no global pointer or separate session index.
- src/core/thread-lock.ts: per-thread flock; keep lock inodes, release via close.
- src/runtime-control/controller.ts: one server-owned call, exact thread leases,
  native identity, readiness, MCP/API redial and full runtime replacement. Keep
  the frontend connected across restart; cancel pointer holds after successful
  preflight and before teardown. In-call Fresh remains removed.
- src/runtime-control/journal.ts: fsynced call-controller-lifetime operations.
  Journal restart handoffs before teardown and submit once after exact resume
  and live media. Keep handoff outcome separate from readiness; never stop healthy
  media on refusal or ambiguous acceptance. Never adopt old journals in a new call.
- src/runtime-control/process.ts + worker.ts + protocol.ts: private bounded
  controller/worker IPC. No audio/RTP/PCM or bearer capabilities in UI events.
- src/runtime-control/sender.ts: bounded worker writes; drop transient voice deltas
  at the soft limit; preserve starts/completions without replacing deltas or failing healthy media.
- src/events/: controller-owned read-only socket with prefix subscriptions,
  sequence-watermarked lifecycle snapshots, transient native voice items/deltas,
  and typed conversation observation. Conversation content has bounded in-memory
  replay and live-item snapshots; native history pages come from the owned child.
  The controller automatically saves private workspace/thread-namespaced voice JSONL
  from call startup; no automatic speech replay or transcript UI.
  The explicit scripts/voice-record.ts observer may additionally export received voice events to
  private per-conversation JSONL for external viewing; never feed recordings back
  into native history, voice startup context, or automatic replay. Never discard voice
  events using lifecycle snapshot watermarks or infer missing native identity.
  No audio/bearer capabilities or mutation/MCP methods. The separate mailbox
  snapshot/replay is controller-owned and survives runtime replacement. Replacement resets
  native inventory; stale incarnations never publish into a successor or another call. See docs/events.md.
- src/core/thread-observer.ts: bounded owned-child loaded inventory and metadata reads,
  never history hydration, resume, or turns. Preserve newer notifications over late reads.
- src/core/conversation-reader.ts + conversation-items.ts: explicit read-only native
  history for controller-leased roots and verified descendants. Scope cursors to
  root/thread/turn/order and runtime generation; never resume or submit work for a
  read. Stock 0.153.4 thread/items/list is a stub despite its schema: item pages use
  thread/turns/list with full items, one turn per native page. Unmaterialized and
  ephemeral history is unavailable, not empty. See docs/conversations.md.
- src/ipc/json-socket.ts: shared private NDJSON framing, ownership and bounded writes
  for both Unix endpoints. Never remove another listener or an unrelated file.
- src/control/: shared Zod contract/dispatch, private UDS NDJSON server,
  loopback Streamable HTTP MCP projection, and private live-controller discovery
  for the explicit `mcp-config` export and local attachment bootstrap. Keep the
  MCP and Unix control operations semantically identical.
- src/mailbox/: verified direct-child lifecycle observation, call-owned completion
  metadata and count-only wake-ups. Each child terminal turn immediately submits
  a named standalone tool output through native turn/start; multiple pending
  notices are expected. The control/MCP mailbox opening atomically consumes only
  returned entries, caches opening results by operation ID, and never creates
  per-message receipts. Working counts are fresh native snapshots, not cleared
  counters. Mailbox state/replay survives runtime replacement; stale generations
  cannot publish or consume. Native owns full child results. See ADR 0026 and
  docs/thread-mailbox.md for capacity, ancestry, caller and retry boundaries.
- src/core/runtime.ts: launch, exact restart resume, voice session, owned child
  lifecycle and runtime-cached settings. No account selection/rotation, custom
  worker manager or in-call Fresh. Custom native turn submissions are limited to
  explicit controller-owned restart handoffs (ADR 0016) and immediate child
  completion-tally wake-ups (ADR 0026).
- src/core/session.ts: counted native voice starts/stops and attribution.
  Stop timeouts do not prove non-delivery: retain each expected requested-close
  until notification or reset; a late refusal must remove only its own stop.
- src/console/host.ts: native readiness before audio opens, negotiation after audio
  readiness, visible media notices, worker-local media wiring and quit cleanup.
- src/console/transport.ts: WebRTC offer/answer, two-peer redial, automatic renewal and bounded retry.
- src/console/duplex-audio.ts + duplex-device.ts + native/: in-process miniaudio
  capture/playback, Opus, bounded PCM rings. Detach clears stale playback.
- src/console/tui.ts: static monochrome YOU/AGENT buttons, conditional pointer
  PTT and connection phase only. No animation, meters, palette or keybindings.
- src/console/state.ts: plain host/observer data; backend imports no TUI renderer.

## Ownership and state invariants

Public voice launches support native/configured permissions without a flag.
Top-level allow-full-access:true in server.json is equivalent to the full-access
CLI flag; top-level debug:true enables runtime debug logs. Both default false,
and CLI opt-ins win over false in the file. Resolve once per runtime generation.
--allow-full-access explicitly requests danger-full-access/never; it wins over
conflicting permission selectors, not unrelated settings. Do not reject launch,
resume or settings reports solely because permissions are restricted or
unreported. Preserve native managed requirements. Command/file/permission approvals,
tool questions and MCP elicitations flow through an attached stock TUI. The server
terminal shows an interaction notice; without a TUI, native Codex retains the request and
replays it on attachment. Never add automatic consent, refusals that race the TUI,
invented answers or an AgentVoice approval queue. Unsupported client tools/auth/
legacy/unknown requests are still refused visibly. See ADRs 0020/0022.

Resolve one existing absolute real workspace before spawning the child:
CLI workspace > explicit file workspace > current managed default generation. Use it for lookup,
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

Each frontend connection starts one call using the server's conversation selection
flags. Explicit workspaces are pinned at server launch; otherwise the default
server resolves the current generation at call start. Every call pins its canonical
workspace through runtime replacements. The default frontend socket stays stable
across generations; explicit CLI workspaces use their own hashed sockets. Close its frontend to end audio,
app-owned work and the Codex child; native history remains untouched. The server
waits for complete teardown before accepting another call. MCP/API runtime restart
retains the frontend, exact thread leases and controller endpoints while replacing
the runtime. Leases last until call shutdown. A cleanup failure prevents subsequent
calls until server termination.
Other workspace servers may run independently; other clients do not honor this guard.

App state: default/workspaces/ generations, default/service/ logs, frontend/ sockets,
thread-locks/ and opt-in unique runs/ logs under
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
- The TUI is pointer-only: two full-height monochrome channel buttons, with
  a bottom push-to-talk button while the mic is muted. Keep existing text labels,
  grey out muted channels, show only connection phase above them. No keybindings,
  modal, animation, meters or additional status. Signals/terminal close end a call.
- Settings and prompt contents load once per runtime generation. No voice-name watcher or
  local catalog; Codex validates voice selection. Native identity and settings
  remain available through server diagnostics and read-only observation.
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
  includeStartupContext defaults to false on every call, including renewal (ADR
  0029 supersedes ADR 0020 for this setting). This matches inspected desktop-client
  JavaScript; the native server omission default is true. Explicit true requests
  the snapshot, false skips it, and raw null restores native resolution.
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
- No AgentVoice worker execution tools, registry, archival or result reports.
  Custom turn submission is limited to explicit MCP/API restart handoffs (ADR
  0016) and immediate metadata-mailbox tally wake-ups (ADR 0026). For handoffs, submit once
  after exact identity and live media checks; never retry ambiguous acceptance,
  echo the private prompt in status/errors or change prompt defaults.
  Native Codex tools, subagents and voice handoffs stay native.
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
  six hours, or on demand by running that script.
  Skill names and descriptions provide capability discovery; do not add a
  second tool catalog to prompts. See `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.


## Voice recording and attachment

`agentvoice attach agent` joins native Codex; `agentvoice attach voice` launches
`codex-viewer --voice-jsonl <saved-file> --follow`. `--list` lists workspace
recordings and `--thread` selects one. Bare attach is an actionable error.
Implicit selection probes the default frontend endpoint read-only, preserving an
active call's pinned workspace; idle/offline selection uses the configured/current
workspace without creating a generation. Explicit workspace always wins.
`src/recording/` owns private per-thread writers and bounded header/tail discovery.
Recording starts at verified native identity before voice events, survives runtime
replacement, and closes after runtime teardown. Preserve canonical completions
through IPC soft pressure and reject foreign/stale runtime events before storage.
Disk errors must be visible without stopping healthy media; never report missing
or interrupted speech as complete, replay it, or write it to native history.
The LaunchAgent label is `io.arthack.agentvoice.server`; explicit installation
retires only the ownership-verified former `dev.agentvoice.default` job.


The macOS service uses the installer-owned signed Bun copy in
`default/service/runtime/AgentVoice.app`, preserving Bun entitlements and adding
`com.apple.security.device.audio-input` plus NSMicrophoneUsageDescription. Never
re-sign Homebrew Bun or write TCC grants. Keep the bundle's stable signing identity,
receipt checks and transactional rollback. Restart validates the persisted bundle
path even if the invoking XDG state differs. Packaging tests use temporary copies,
signing inspection and --version only; actual microphone consent remains macOS-owned.
