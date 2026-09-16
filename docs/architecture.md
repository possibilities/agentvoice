# Architecture and source ownership

Read this map before changing a subsystem, together with the ownership and state
invariants in [AGENTS.md](../AGENTS.md#ownership-and-state-invariants), the
[glossary](../CONTEXT.md), and the relevant [decision records](adr/README.md).
Paths written as code below are relative to the repository root. This document
owns the current source map and recording/attachment implementation guidance.

## Source map

- src/threads/: native observer, terminal thread display and versioned `threads --json`
  export for independent metadata consumers. A fenced read combines the live
  inventory with persisted native descendant pages and reports per-row parentage
  provenance or missing/conflicting evidence. It never infers semantic Work or an
  exact receiving turn. AgentHUD owns its durable Work and UI in a separate
  repository, with no cross-checkout imports or source ownership here. See
  [ADRs 0056](adr/0056-independent-agenthud.md) and
  [0068](adr/0068-durable-native-parentage-export.md).

- scripts/install.ts: clean checkout, frozen dependencies, staged native build,
  ownership-safe editable command publication and deployed-sha receipt, followed by
  the native menu app and default LaunchAgent installation on macOS. --command-only
  skips both app and service management; --menu-only builds and publishes only the
  app, with explicit --quit-menu presence preservation through its private control
  endpoint and no LaunchAgent action.
  No configuration, prompt/skill setup or legacy command cleanup.
- macos/ + scripts/build-macos-app.sh: AppKit status item, native main-app login
  registration, versioned service-state observation and explicit load/unload/restart
  through the existing ownership-checked service command, reusable SwiftUI pairing window,
  private render-gated pairing-socket client, private same-user menu lifecycle control,
  and signed application packaging.
  The menu is not a frontend or server supervisor; quitting
  it must not end a call. Follow AgentNotify for native panels, windows and shared
  SwiftUI content.
- src/macos-app.ts: ownership, signing, source-revision and running-process checks,
  opt-in graceful quit orchestration, conditional exact-path relaunch, and atomic
  menu app installation. Keep its bundle identity distinct from the
  private microphone-entitled Bun runtime below AgentVoice state.
- scripts/install-android*: clean-checkout ARM64 standalone build plus an explicit
  SSH deployment to prepared Termux. Keep the target and receipt ownership-correlated,
  stage and verify before atomic publication, and never install phone packages,
  configuration, credentials or services or start a call during convergence.
- src/service.ts: owned user LaunchAgent install/status/restart/remove, explicit argv
  and selected environment, private logs, bounded launchctl, kernel-released shared
  operation locking and failed-install rollback.
  Never adopt an unrelated loaded job or edited/unsafe plist, or open audio as a check.
- src/workspace.ts: default/workspaces generations under XDG state; newest sortable
  timestamp-and-UUID name wins, independent of mtimes. Initial creation is atomic;
  reject unsafe selected directories. Resolve and pin the current generation at
  server launch when it has a valid marker; otherwise resolve it when the first
  frontend creates the lazy workspace session. Keep it pinned until server
  shutdown. No reset/deletion or context-policy changes.
- web/: Agent | Voice browser composition using the AgentVoice-owned transcript
  source in `web/src/transcript-ui/`. Its provider-neutral data helpers, Codex adapters,
  React components, readable style sources and deterministic scoped stylesheet build
  are one internal boundary. `server/live-reader.ts` observes the default or explicitly selected workspace
  frontend without fallback, verifies the live
  controller and fences native history/live snapshots and saved voice tails.
  `server/agent-controls.ts` owns explicit Agent composer input and the private paused-on-restart
  queue; `server/agent-sender.ts` uses the existing exact-thread attachment gateway.
  `server/file-picker.ts` supplies bounded read-only home-directory metadata; the
  composer inserts selected or pasted absolute paths as ordinary `@path` text.
  Raw clipboard images use `src/attachment/local-images.ts` for private bounded local
  materialization; composer controls carry paths and the gateway emits native
  `localImage` parts. No browser-selected endpoints, native RPC forwarding or call ownership.
  `src/web-serve.ts` owns the exact configured portless origin and foreground process; Vite
  dev is editable by default. See [the web contract](../web/README.md).
- src/threads/: one-shot read-only native-thread table for `agentvoice threads` and
  `watch`. Reuse frontend/controller discovery and the event socket; at most four
  metadata reads in flight. Read only bounded metadata pages from native persisted
  history; never start a call, resume a thread, read item bodies, or guess Work,
  model or effort. Keep idle threads and unresolved parent evidence visible.
- src/main.ts: server/frontend CLI and workspace canonicalization. Bare invocation
  prints help; `client` remains the explicit pointer frontend. Former
  accounts/resident/remote/console verbs and terminal attachment forms error.
- src/frontend/: strict private workspace socket, one retained workspace session,
  exclusive disposable media ownership and minimal state/input protocol. It also
  carries validated browser SDP/control messages for every attachment over frontend
  version 3, never RTP/Opus/PCM. Server startup restores and pins a valid marked
  backend without media; the first owner lazily starts an unmarked backend.
  Disconnect releases PTT, forces effective mute and stops realtime media while
  preserving the controller, runtime, native work and endpoints. Never accept a
  successor until detach completes or automatically reconnect/replay. A successor
  may use a fresh clientId and negotiates fresh media against the same backend.
  Fresh clients observe explicit closing state and wait at most 30 seconds before
  requesting ownership; observation never reserves admission. Connected and
  unavailable states fail immediately.
- src/browser/: same-device phone page, loopback HTTP/WebSocket gateway and
  bounded browser-media protocol. Bind only `127.0.0.1`; retain the random token
  path, exact Host/Origin checks, one-owner reservation, browser security headers,
  explicit Start gesture and session IDs. Page/socket loss owns media detach;
  it does not tear down the retained workspace session.
  Never persist or expose its URL through discovery, accept arbitrary content,
  rebind for LAN/tailnet/ADB access. The bridge may connect to authenticated WSS
  while the page remains same-device. See ADRs [0032](adr/0032-loopback-browser-media-frontend.md)/[0034](adr/0034-authenticated-client-network.md).
- src/network/: legacy WSS bearer grants, durable public-key device pairing,
  one-use connection challenges, loopback TLS-proxy backend, bounded heartbeat
  framing and client adapter. The native menu and CLI prepare enrollment through
  a separate private UDS and activate it only after rendering. Network and local
  owners share the same VoiceServer. The default server keeps the existing
  network namespace; an explicit workspace opts into isolated settings, device
  records and pairing socket with `network ... --workspace <dir>`.
  Fail closed on invalid credentials, Origin, protocol, frames and liveness;
  close local media ownership immediately without waiting for a network close handshake.
  No automatic reconnect, secret logging, TLS bypass or public Funnel deployment.
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
- src/core/role-content.ts: bounded directory-role preflight content observations and
  read-only source digests for control status. Prompt/MCP readers supply their exact
  loaded buffers; skills retain their existing live native root. DB snapshots never
  use directory-content status. See [ADR 0069](adr/0069-directory-role-content-status.md).
- src/core/codex-config.ts: ordered native startup overrides; validate only argv
  shape and product-invariant choices, never rewrite the forwarded strings.
- src/core/params.ts: pure config/prompts → native thread and realtime requests.
  VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md owns native multi-agent mode plus V2
  enablement on start/resume. AgentStart's manager and worker roles carry it; roles without
  the file inherit native policy. Preserve unrelated V2 settings; duplicate mode owners, disabled
  V2 and raw config replacement that drops the file are launch errors.
  Codex normally ignores unknown fields; do not promise errors on passthrough typos.
  Default effective WebRTC requests to v3 for compatibility after raw merging.
  Explicit versions/null and alternate transports win. Distinguish Codex client
  selection from app-server omission; v3 aligns with the desktop path noted above.
  No automatic speech-history reads, initial items or reconnect instructions.
  quiet-resume and replay-spoken-history are retired; their config keys error.
  AgentVoice defaults includeStartupContext to false at the request boundary on
  every call, matching the desktop client; app-server omission instead means true.
  See [ADR 0029](adr/0029-desktop-startup-context.md) before changing this default. Explicit true/false/null passthrough
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
  native loopback listener, exact-root policy gateway and controller bootstrap for
  host-owned web Agent input and explicit speech. Never expose the native credential,
  executable path or request selection to browser code. Permit only initialize,
  turn start/steer/interrupt and root-only thread/realtime/appendSpeech; reject
  reads, settings, descendants, native-question answers and arbitrary methods before
  native dispatch. Tickets require a watcher, expire unused after 30 seconds and
  are fenced to controller generation, workspace and root thread. Runtime restart
  and server shutdown revoke before teardown; frontend detach, redial and automatic
  renewal preserve the gateway. Never retry input or speech automatically or report
  acceptance as completion/playback.
- src/core/session-marker.ts: private workspace `.agentvoice-session` marker,
  bounded safe reads, exclusive atomic publication and fsynced deletion. Runtime
  validates exact native main-thread ownership; no latest-history lookup or fallback.
- src/core/thread-lock.ts: per-thread flock; keep lock inodes, release via close.
- src/runtime-control/controller.ts: one server-owned workspace session, exact thread leases,
  workspace lease before startup, explicit new-session replacement and child-turn dedupe reset,
  native identity, readiness, MCP/API redial and full runtime replacement. Preserve
  controller ownership across frontend detach; cancel pointer holds on detach and
  after successful replacement preflight. Redial and immediate voice application
  require an attached frontend. Explicit new-session replacement clears the marker after cleanup.
- src/runtime-control/journal.ts: fsynced controller-lifetime operations retained
  across frontend attachments.
  Journal restart handoffs before teardown and submit once after exact resume
  and live media. Keep handoff outcome separate from readiness; never stop healthy
  media on refusal or ambiguous acceptance. Never adopt old journals in a new server session.
- src/runtime-control/process.ts + worker.ts + protocol.ts: private bounded
  controller/worker IPC. All workspace sessions select the no-device client media adapter
  and relay validated SDP/control; no audio/RTP/PCM or bearer capabilities enter
  UI events. Detach stops only realtime voice; explicit restart/new-session or
  server shutdown owns worker teardown. Compiled Android workers must dispatch through the executable, not
  virtual `/$bunfs` paths.
- src/runtime-control/sender.ts: bounded worker writes; drop transient voice deltas
  at the soft limit; preserve starts/completions without replacing deltas or failing healthy media.
- src/events/: controller-owned read-only socket with prefix subscriptions,
  sequence-watermarked lifecycle snapshots, transient native voice items/deltas,
  and typed conversation observation. Conversation content has bounded in-memory
  replay and live-item snapshots; native history pages come from the owned child.
  The controller automatically saves private workspace/thread-namespaced voice JSONL
  from workspace-session startup. Saved speech remains read-only observation; it is never converted into
  automatic realtime initial items (ADR 0074).
  The explicit scripts/voice-record.ts observer may additionally export received voice events to
  private per-conversation JSONL for external viewing; never feed recordings back
  into native history or automatic replay; exported observer files are not a
  continuity source. Never discard voice
  events using lifecycle snapshot watermarks or infer missing native identity.
  No audio/bearer capabilities or mutation/MCP methods. Direct-child completion
  delivery is not an event snapshot/replay or control API. Replacement resets
  native inventory; stale incarnations never publish into a successor or another server session. See docs/events.md.
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
  MCP and Unix control operations semantically identical. Runtime readiness uses
  one read-only, thread-scoped `agentvoice_status` tool call to prove the unique
  authenticated server and its statically registered enabled catalog. Never gate
  voice startup on `mcpServerStatus/list`: native Codex rebuilds the global MCP
  inventory for that request and waits for unrelated servers.
- src/completions/: the bounded completion-delivery contract and verified
  direct-child lifecycle observer. Each newly observed terminal child turn submits
  one standalone native tool output through `turn/start`, carrying that completion's
  identity/status metadata and a fresh in-flight snapshot. The controller retains
  only exact child/turn dedupe identities across frontend detach and runtime
  replacement; `new_session` and server shutdown clear them. There is no completion
  queue, opening API, cached opening, replay, or result store. Stale generations
  cannot publish. Native owns full child results. See
  [ADR 0080](adr/0080-direct-child-completion-delivery.md) and
  [direct child completions](direct-child-completions.md).
- src/core/runtime.ts: launch, exact restart resume, attach/detach of realtime voice,
  owned child lifecycle and runtime-cached settings. Frontend detach stops only
  realtime voice; native work and attachment gateway remain. No account selection/rotation, custom
  worker manager. Custom native turn submissions are limited to
  explicit controller-owned restart handoffs ([ADR 0016](adr/0016-restart-handoff.md)) and immediate direct-child
  completion outputs ([ADR 0080](adr/0080-direct-child-completion-delivery.md)).
- src/core/session.ts: counted native voice starts/stops and attribution.
  Stop timeouts do not prove non-delivery: retain each expected requested-close
  until notification or reset; a late refusal must remove only its own stop.
- src/console/host.ts: media-adapter readiness before media starts, negotiation
  after readiness, visible media notices, worker-local media wiring and explicit
  frontend attach/detach. Detach fences offers before stopping realtime voice and
  never tears down native work.
- src/frontend/native-media.ts + native-peer.ts: client-owned device and WebRTC,
  bounded peer lifecycle and stale completion fences. client-runtime.ts uses the
  installer-owned signed macOS runtime for microphone permission identity.
- src/console/duplex-audio.ts + duplex-device.ts + native/: in-process miniaudio
  capture/playback, Opus, bounded PCM rings. Detach clears stale playback.
- src/console/client-session.ts + client-media.ts + media-state.ts: shared server
  signaling and session policy for native and browser media. Preserve session
  checks, retry/renewal bounds and client-only devices. Never restore native
  server media or platform selection. See docs/client-api.md and [ADR 0033](adr/0033-client-owned-native-media.md).
- src/console/tui.ts: static monochrome YOU/AGENT buttons, conditional pointer
  PTT and connection phase only. No animation, meters, palette or keybindings.
- src/console/state.ts: plain host/observer data; backend imports no TUI renderer.

## Native Android and design studio

The native Android client owns its WebRTC and audio through authenticated WSS;
its private foreground `CallService` retains the controller independently of
Activity navigation. Back and foreground changes release PTT without ending the
call; explicit Disconnect or notification Hang up closes it. See
[Android call navigation](android-call-navigation.md) for service and notification
ownership, launch policy and Studio rehearsal boundaries.
Read [the Android implementation boundaries](../android/README.md#implementation-boundaries)
before changing it. The debug-only host [design studio](../android/configurator/README.md)
owns synthetic preview controls and profiles. Its saved design choices are
exploratory and must not silently become production layout or defaults.
The explicitly adopted baseline lives in `android/design/shipping-profile.json`;
`shipping.ts promote` generates constants and selected release assets from a complete
profile. Gradle checks drift. Reusable renderers live in main and consume real
`CallUi` in production; the bridge, synthetic session and alternative asset library
remain debug/host only. Save includes every visual choice, while runtime rehearsal
state stays outside profiles. See the Android README for promotion and APK audits.

## Voice recording and web reading

`src/recording/` owns private per-thread writers and bounded header/tail discovery.
Recording starts at verified native identity before voice events, survives runtime
replacement, and closes after runtime teardown. Preserve canonical completions
through IPC soft pressure and reject foreign/stale runtime events before storage.
Disk errors must be visible without stopping healthy media; never report missing
or interrupted speech as complete, replay it, or write it to native history.
The web Voice lane opens one verified recording inode, enforces workspace/thread
headers and bounded records, and never follows file replacement or truncation.
The LaunchAgent label is `io.arthack.agentvoice.server`; explicit installation
retires only the ownership-verified former `dev.agentvoice.default` job.


The macOS service uses the installer-owned private signed Bun copy in
`default/service/runtime/AgentVoice.app`, distinct from the user-facing menu app.
It preserves Bun entitlements and adds
`com.apple.security.device.audio-input` plus NSMicrophoneUsageDescription. Never
re-sign Homebrew Bun or write TCC grants. Keep the bundle's stable signing identity,
receipt checks and transactional rollback. Restart validates the persisted bundle
path even if the invoking XDG state differs. Packaging tests use temporary copies,
signing inspection and --version only; actual microphone consent remains macOS-owned.


Voice discovery is owned by `src/core/voice-catalog.ts`: query the owned native child,
validate bounded protocol families/defaults, cache successful declarations per child,
and retain explicit unavailable results. `voice-inspection.ts` owns the shared inspection
shape and final WebRTC protocol mapping. Runtime tracks the matching started request;
the media host qualifies it with live media. Control exposes dedicated `voice_get` and
validates `voice_set` before saving. SQLite receipts retain resolved random choices,
while the controller journal separately owns saved/application outcomes (ADR 0054).

The host transcript reader selects the default frontend endpoint unless launched
with an explicit canonical workspace. Named readers never fall back to the default
endpoint. Their host-owned pending-input queues live in workspace-hashed
`web/queues/` directories; the default endpoint retains `web/queued-messages.json`
for backward-compatible recovery. Reader origin names are deployment labels, not
queue or native session identity. See [ADR 0073](adr/0073-parallel-workspace-web-readers.md).
