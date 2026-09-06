# 0017: Attach a stock TUI through a guarded local gateway

Accepted 2026-09-05 for an opt-in worktree implementation. Extends ADR 0015's
owned-child topology and ADR 0016's native text submission path. Default voice
launches retain stdio; live voice plus TUI behavior requires a separate trial.

The user wants to follow the voice orchestrator's work and steer it by typing.
A stock Codex TUI can warm-resume the same live native thread and subscribe to
its events. Opening the native listener directly is insufficient: a second
client can create threads or change permissions before the owner observes the
change. Native server questions are broadcast and the first answer wins, so
letting the TUI answer while AgentVoice refuses introduces a race.

`--allow-tui-attach` is a launch-only opt-in. The runtime starts its owned stock
app-server on an authenticated ephemeral loopback WebSocket instead of stdio.
A unique private state directory holds the mode-0600 native token file. The
runtime owns the listener, credential, gateway, and child process lifetime;
shutdown removes the token directory. No native credential is given to the TUI.

`agentvoice attach --allow-full-access` discovers a live controller using exact
canonical workspace and optional thread, validated against live Unix status.
It calls a private authenticated HTTP bootstrap with instance, generation,
workspace and thread. This adds no MCP tool or Unix control operation. The
controller verifies identity/readiness on both sides of the runtime request.
The runtime issues a one-use watcher/TUI admission ticket valid for 30 seconds,
bound to its current exact thread by gateway lifetime and revocation.

The launcher opens a watcher, then runs the same absolute stock executable with
`resume --remote`, exact thread/workspace and full access / never. The bearer
travels in an environment variable, not argv. Each TUI gets its own native
connection, initialization, correlation and subscription. AgentVoice does not
reimplement native history, item reconstruction, turns or tools.

The gateway validates before dispatch. It allows required read/bootstrap
requests, exact-thread resume/history, start/steer/interrupt and compatible
session settings. It rejects unknown mutations and other-thread actions,
permission/workspace changes, configuration/account writes and realtime control.
Unknown null serde placeholders are removed before forwarding; supported null
values keep their native meaning. Thread-list results and notifications are
filtered. All server requests and client answer frames are withheld so the
runtime remains the only human-interaction refusal owner. This is a protocol
boundary, not a filesystem sandbox: typed instructions still run with full access.

Fresh revokes before switching identity; runtime shutdown revokes before media
teardown; full quit closes everything. Redial preserves attachment. A revoked
watcher terminates the stock TUI with bounded TERM/KILL and restores terminal
state, preventing its reconnect path from replaying input onto a replacement.
Reattachment is explicit. Stock `/quit` acknowledges unsubscribe but can close
without a WebSocket close handshake; only the latest acknowledged unsubscribe
with no intervening request qualifies that close as normal. Runtime revocation
and native failure remain abnormal regardless. Explicit native interruption or
running-task Exit may stop work; ordinary detach leaves the owner running.

The initial surface deliberately excludes thread creation/fork/archive/rollback,
plugin management, renaming, approval answers and live voice transcript mirroring.
There is no arbitrary address/PID option, resident service, remote mode, automatic
installation, credential migration, prompt change or attachment to a prior
stdio-only launch. A future native scoped-client API could replace the gateway
only after establishing these boundaries upstream.

Validation: stock Codex 0.153.4 boundary probes demonstrated direct-listener
permission/thread escape. A real PTY with an isolated local fake Responses API
verified warm resume, owner-event display, idle typed turns, active turn steering,
clean `/quit`, and revocation. Fake native/media tests cover request refusal,
answer suppression, credential invalidation, stale identity, Fresh, redial,
runtime replacement and shutdown. No credentials, live inference or audio are
used by these tests; they do not establish simultaneous live voice fidelity.
