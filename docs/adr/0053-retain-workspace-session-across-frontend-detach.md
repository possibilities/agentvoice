# 0053: Retain one workspace session across frontend detach

Accepted 2026-09-13 at the operator's request. Supersedes the frontend-disconnect
teardown boundary in [0024](0024-server-and-pointer-frontend.md),
[0032](0032-loopback-browser-media-frontend.md),
[0033](0033-client-owned-native-media.md), and
[0038](0038-thread-mailbox-wakeups.md). It also supersedes the per-call default
workspace selection in [0025](0025-launchagent-default-workspaces.md) and the
corresponding disconnect language in [0034](0034-authenticated-client-network.md),
[0036](0036-desktop-mobile-attachment.md), and
[0052](0052-workspace-session-marker.md). Their historical text and all unrelated
security, media ownership, continuation, attachment, mailbox, and replacement
decisions remain.

The first-frontend lazy-start rule and its default-workspace selection timing are
superseded for valid marked workspaces by
[0071](0071-restore-marked-session-on-server-start.md). Markerless workspaces and
all detach/retention boundaries below remain active.

## Decision

One `agentvoice server` process owns at most one workspace session. It creates
that session lazily when the first frontend is admitted, selects and pins the
canonical workspace, resumes or creates the workspace marker's exact root thread,
and starts the controller and voice runtime. The session then lasts until explicit
server shutdown, even when no frontend is connected. A default server therefore
does not select a newer managed workspace generation between frontend attachments;
a new server lifetime selects the then-current generation. An explicitly configured
workspace remains pinned as before.

The workspace session retains its controller instance, runtime and owned stock
Codex app-server, exact root and verified native child handles, workspace/thread
leases, attachment gateway, lifecycle and conversation observation, thread
mailbox, operation journal, transcripts, and control/event endpoints. Native work
may continue while the frontend is absent, and mailbox completion observation and
wake-ups remain in the same controller lifetime. Detach does not submit a turn,
resume a thread, replay input, or create another session.

A frontend connection is a disposable media attachment to that retained session.
Only one frontend may own media at a time. Its `call` request may use a fresh
`clientId`; reattachment does not require the former client's correlation ID.
Disconnect releases transient holds, makes both channels effectively muted,
closes client-owned capture, playback and WebRTC, and requests a native realtime
stop. Successful detach requires acknowledgement of that stop, after which no
realtime speech is sent or received while detached. A refusal or timeout leaves
the backend stop outcome unknown, reports the failure, and poisons media admission
until server restart while retaining native work. The server admits a later
frontend only after detach is fenced; that frontend starts a fresh media peer
against the same controller, runtime, workspace and root thread.

Persistent microphone and speaker mute assignments keep their existing semantics
and survive detach. A hold remains transient and is always released. Reattachment
does not replay controls, prompts, SDP, or speech.

Voice redial and immediate voice application require an attached frontend because
they replace realtime voice only. Automatic renewal exists only while attached.
Explicit runtime restart remains available as the intentional operation that
replaces the disposable runtime and owned Codex child while retaining the
controller and exact root. Explicit `new_session` intentionally replaces the
runtime, clears the old workspace marker and mailbox, and creates a new root
within the same pinned workspace session. When detached, replacement readiness
means the native runtime is ready; it does not claim live media or audible speech.

Explicit server shutdown is the terminal boundary. It closes any media attachment,
the retained runtime and Codex child, gateways and endpoints, releases leases, and
clears controller-owned transient state. A later server process starts with a new
controller lifetime and lazily selects its workspace on its first frontend.

## Consequences

Client loss is no longer a cancellation signal for native work. A user who means
to end the retained work must explicitly stop the server or use an operation whose
documented purpose is replacement. Clients and observers must distinguish media
attachment availability from workspace-session identity: `busy` continues to mean
a frontend currently owns the media attachment, while discovery may expose the
retained workspace and thread when `busy` is false.

The server still owns no production audio. Terminal, browser and Android clients
must close local devices immediately on loss. A successful detach establishes
that the retained backend cannot hear or speak; a failed detach reports an unknown
native stop outcome and admits no successor. The loopback browser URL, WSS authentication, one-owner rule,
session-correlated signaling, and client-side stale-completion fences are unchanged.

Fake protocol and media tests can establish detach/reattach fencing, identity
retention and explicit shutdown cleanup. They do not establish live microphone,
speaker, network, or audible speech behavior.
