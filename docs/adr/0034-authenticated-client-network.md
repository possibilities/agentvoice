# 0034 — Authenticated WSS transports the same client API

Accepted, 2026-09-08. Extends ADR 0033 and narrowly supersedes ADR 0032's
same-device upstream limitation; it does not widen the browser listener.

The operator requested a native Android handoff and a browser proof against both
Termux and the desktop over Tailscale. Media remains client-owned. Add WSS to
frontend API v2, not a second controller, native Codex gateway, media proxy or
remote terminal composition.

Each authenticated network connection owns one private frontend connection.
The existing VoiceServer enforces exclusivity across local and remote clients,
observer restrictions, exact identity, teardown and poisoned-cleanup admission.
Default servers opt in through private network settings; explicit workspace
servers remain local. Configuration and call-selection policy stay server-owned.

TLS terminates on a dedicated tailnet-only Tailscale Serve port. The application
backend binds only 127.0.0.1, rejects Origin headers and validates the exact
protocol, Host, path, credential and frames. The default desktop installer
reconverges an already enabled route through AgentStart; initial enable is an
explicit action. No Funnel or changes to unrelated routes are permitted.

Per-device 256-bit secrets expire after 30 days. Server records retain only
SHA-256 hashes, identity, label and expiry; private export profiles contain the
raw grant. Revocation/expiry is checked on frames and heartbeat ticks. Transport
loss ends the call, never resumes it or replays controls. Heartbeat bounds and
resource caps are part of the published client contract.

The browser proof stays a capability-bearing loopback page. Its Termux bridge
selects local UDS or a private WSS profile; neither page JS nor browser storage
receives a device credential. Native Android replaces that bridge/page with its
own WSS, microphone and WebRTC implementation. The same desktop server and schema
serve the terminal client and native Android. Attachments, history access and
native human approvals retain their existing server-local interfaces.

The operator additionally requested in-page server switching and stable PTT
layout. A bridge launched with a private profile offers only `local` and `remote`
server IDs, never arbitrary browser-selected URLs. It remains idle between calls;
page loss, selection change and socket loss still close the owned call and media.
Every successor requires an explicit Start. This supersedes the proof's previous
exit-on-first-owner-disconnect behavior, not its one-owner security boundary.

Tradeoffs: one authenticated device grant allows controlling a call with the
server's configured Codex permissions; this is not a sandbox or multi-user tenant
boundary. The TLS proxy is trusted. Remote call admission is single-attempt;
busy/closing requires explicit retry. Renewal requires a newly exported grant.
Background calling is not an implicit transport feature. See the handoff runbook
for client shutdown requirements and validation evidence.
