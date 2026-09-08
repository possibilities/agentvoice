# 0033: All call clients own audio and WebRTC

Accepted September 8, 2026 by the operator. Supersedes the native-media ownership
in ADRs 0024 and 0032. The browser proof remains a disposable UI, not a second
server architecture.

## Boundary

`agentvoice server` and its runtime own configuration, authentication to Codex,
conversation identity, leases, transcripts, native work, approvals, attachments,
session policy, renewal and restart. Neither production server process opens a
microphone, loads a native audio library, creates a WebRTC peer, or handles audio.

`agentvoice client` owns the native duplex device, Opus, WebRTC peers and pointer
UI. The browser owns their browser equivalents. Both implement the same bounded
session-correlated signaling messages. A server does not select a media backend
based on the client's platform. Native audio options belong to the client.

The server requests a new peer with `prepare`; the client returns an offer, the
server obtains the native answer, and the client reports actual connectivity.
Server-controlled effective mute state gates local capture/playback. Local
shutdown always mutes and closes devices independently of server cooperation.
Clients never receive Codex credentials and never call Codex RPC themselves.

Call ownership remains bound to one frontend connection. Connection loss ends
the call and owned work. Media-session close does not close that connection:
redial and runtime replacement may prepare another session. No automatic new
call or spoken-history replay occurs. The old native peer may play through
successor negotiation; stale callbacks cannot change its successor.

## Compatibility and deployment

The private frontend API advances to version 2. Version 1 is rejected before
call admission; there is no server-media fallback. Desktop server/client and
Termux server/browser bridge must be updated together. Old generated phone URLs
are disposable; reopening `agentvoice phone` creates a fresh one.

The installed macOS client runs under the installer-owned signed AgentVoice.app
Bun copy for the existing microphone permission identity. No TCC grant or
Homebrew Bun signature is modified. The waiting server has no audio requirement.

See [the client API](../client-api.md) for the contract. Network authentication,
TLS, pairing and a native Android UI remain separate from the same-device
browser proof. A future network transport must preserve the same exclusive
owner and teardown semantics, not widen the proof's loopback bearer URL.
