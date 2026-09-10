# Architecture and source ownership

Read this map before changing a subsystem, together with the ownership and state
invariants in [AGENTS.md](../AGENTS.md#ownership-and-state-invariants), the
[glossary](../CONTEXT.md), and the relevant [decision records](adr/README.md).
Paths written as code below are relative to the repository root. This document
owns the current source map and recording/attachment implementation guidance.

## Source map

- scripts/install.ts: clean checkout, frozen dependencies, staged native build,
  ownership-safe editable command publication and deployed-sha receipt, followed by
  default LaunchAgent installation on macOS. --command-only skips service management.
  No configuration, prompt/skill setup or legacy command cleanup.
- scripts/install-android*: clean-checkout ARM64 standalone build plus an explicit
  SSH deployment to prepared Termux. Keep the target and receipt ownership-correlated,
  stage and verify before atomic publication, and never install phone packages,
  configuration, credentials or services or start a call during convergence.
- src/service.ts: owned user LaunchAgent install/status/restart/remove, explicit argv
  and selected environment, private logs, bounded launchctl and failed-install rollback.
  Never adopt an unrelated loaded job or edited/unsafe plist, or open audio as a check.
- src/workspace.ts: default/workspaces generations under XDG state; newest sortable
  timestamp-and-UUID name wins, independent of mtimes. Initial creation is atomic;
  reject unsafe selected directories. No reset/deletion or context-policy changes.
- src/threads/: one-shot read-only loaded-thread table for `agentvoice threads` and
  `watch`. Reuse frontend/controller discovery and the event socket; at most four
  metadata reads in flight. Never start a call, resume, read history, or guess
  model/effort. Keep idle threads and unresolved parent links visible.
- src/main.ts: server/frontend CLI and workspace canonicalization; former
  accounts/resident/remote/console verbs error.
- src/frontend/: strict private workspace socket, exclusive call ownership and
  minimal state/input protocol. It also carries validated browser SDP/control
  messages for every call over version 2, never RTP/Opus/PCM. Disconnect
  releases PTT and stops the call; never
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
  `--attach` is the desktop-only two-pane variant for another client's call;
  it starts no client/audio and closing its apps never stops that call.
  `--host` uses verified SSH for bounded transcript observation and the backend's
  existing stock TUI. Keep smolmux/codex-viewer on desktop. Pin client, workspace,
  thread, controller instance and generation; loss or replacement ends the view.
  Never expose these transports through the voice WSS gateway. Temporary desktop
  transcript copies are private, bounded and removed after pane cleanup
  ([ADR 0036](adr/0036-desktop-mobile-attachment.md)).
- src/browser/: same-device phone page, loopback HTTP/WebSocket gateway and
  bounded browser-media protocol. Bind only `127.0.0.1`; retain the random token
  path, exact Host/Origin checks, one-owner reservation, browser security headers,
  explicit Start gesture and session IDs. Page/socket loss owns call teardown.
  Never persist or expose its URL through discovery, accept arbitrary content,
  rebind for LAN/tailnet/ADB access. The bridge may connect to authenticated WSS
  while the page remains same-device. See ADRs [0032](adr/0032-loopback-browser-media-frontend.md)/[0034](adr/0034-authenticated-client-network.md).
- src/network/: WSS device grants, loopback TLS-proxy backend, bounded heartbeat
  framing and client adapter. Network and local owners share the same VoiceServer.
  Fail closed on invalid credentials, Origin, protocol, frames and liveness;
  close local ownership immediately without waiting for a network close handshake.
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
  controller/worker IPC. All calls select the no-device client media adapter
  and relay validated SDP/control; no audio/RTP/PCM or bearer capabilities enter
  UI events. Compiled Android workers must dispatch through the executable, not
  virtual `/$bunfs` paths.
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
  cannot publish or consume. Native owns full child results. See [ADR 0038](adr/0038-thread-mailbox-wakeups.md) and
  docs/thread-mailbox.md for capacity, ancestry, caller and retry boundaries.
- src/core/runtime.ts: launch, exact restart resume, voice session, owned child
  lifecycle and runtime-cached settings. No account selection/rotation, custom
  worker manager or in-call Fresh. Custom native turn submissions are limited to
  explicit controller-owned restart handoffs ([ADR 0016](adr/0016-restart-handoff.md)) and immediate child
  completion-tally wake-ups ([ADR 0038](adr/0038-thread-mailbox-wakeups.md)).
- src/core/session.ts: counted native voice starts/stops and attribution.
  Stop timeouts do not prove non-delivery: retain each expected requested-close
  until notification or reset; a late refusal must remove only its own stop.
- src/console/host.ts: media-adapter readiness before media starts, negotiation
  after readiness, visible media notices, worker-local media wiring and quit cleanup.
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
read [the Android implementation boundaries](../android/README.md#implementation-boundaries)
before changing it. The debug-only host [design studio](../android/configurator/README.md)
owns synthetic preview controls and profiles. Its saved design choices are
exploratory and must not silently become production layout or defaults.
The explicitly adopted baseline lives in `android/design/shipping-profile.json`;
`shipping.ts promote` generates constants and selected release assets from a complete
profile. Gradle checks drift. Reusable renderers live in main and consume real
`CallUi` in production; the bridge, synthetic session and alternative asset library
remain debug/host only. Save includes every visual choice, while runtime rehearsal
state stays outside profiles. See the Android README for promotion and APK audits.

## Voice recording and attachment

`agentvoice attach agent` joins native Codex; `agentvoice attach voice` launches
`codex-viewer --voice-jsonl <saved-file> --follow`. `--list` lists workspace
recordings and `--thread` selects one. Bare attach is an actionable error.
`agentvoice --attach [--host <ssh-host>]` opens the desktop two-pane view.
Attachment admission follows verified native thread/control readiness, independent
of media readiness; runtime replacement still revokes the previous generation.
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
