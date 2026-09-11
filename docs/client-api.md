# AgentVoice client API, version 3

The production client/server boundary is **session control, never media**.
`src/frontend/protocol.ts` and `media-protocol.ts` own the Zod contracts;
`connectFrontend` is the TypeScript client. The browser bridge and native
terminal client use that same client. No platform selector is sent.
`client.schema.json` is the generated JSON Schema for non-TypeScript clients;
regenerate with `bun scripts/generate-client-schema.ts`. A drift test pins it.

## Transport and authority

Local transport: UTF-8 newline-delimited JSON on an owned mode-0600 Unix socket
under the private AgentVoice state directory. Each request has
`{v:3,type:"request",id,method,params?}`. Responses correlate `id` and return
`{v:3,type:"response",id,ok:true,result}` or `ok:false,error:{message}`.
State updates are `{v:3,type:"state",state}`; media events are
`{v:3,type:"client-media",message}`. The control-plane socket framing cap is
1 MiB; SDP strings are capped at 192 KiB, peer IDs are UUIDs, failure details
at 256 characters. No SDP is included in diagnostics, events or transcripts.

The socket's OS ownership is authentication. `clientId` and `sessionId` are
correlation, not authentication. Network transport is one JSON text frame per WSS
message at `/v2/client`, subprotocol `agentvoice.v2`, with a device Bearer credential
in the upgrade Authorization header. It preserves these exact API envelopes;
there is no NDJSON batching over WSS. Network-only ping/pong envelopes are included
in `client.schema.json`. See [Android handoff](android-client-handoff.md) for TLS,
heartbeat, limits, revocation and the complete deployment/import lifecycle.
The prototype loopback URL is never remote authentication.

Frontend v3 requires `codingActivity` on every state. Upgrade server and clients
together; v2 frontend frames are incompatible. The network endpoint, subprotocol,
device grants and network-only ping/pong remain v2; existing grants need no
replacement. Authentication-only QR validation does not negotiate a call version.

## Android device enrollment

After configuring the dedicated private Tailscale WSS route, use **Pair phone…**
in the desktop AgentVoice menu, or run `agentvoice network pair`. Both surfaces
activate the enrollment only after rendering the code and cancel an unredeemed
code when closed. Their `agentvoice-pair:v1:` QR carries a five-minute,
one-use enrollment capability, not the long-lived call credential. The phone
creates a nonexportable P-256 signing key and persists the exact enrollment
request encrypted in no-backup storage before posting to same-authority HTTPS
`/v2/pair`. A lost reply has an explicit exact-request recovery path for 24 hours;
foregrounding never resubmits enrollment automatically.

Successful enrollment stores the device and server identities. Each later WSS
connection gets a fresh challenge from `/v2/auth/challenge` and signs the device,
challenge, nonce, method, canonical authority, path and subprotocol using
SHA256withECDSA. Only the public key leaves Keystore. Enrollment and challenges
create no frontend owner, call or media. The network path/subprotocol and frontend
API versions remain unchanged. The complete protocol is [ADR 0046](adr/0046-durable-device-pairing.md).
The frozen interop vector is
[`pairing-v1.json`](../tests/fixtures/pairing-v1.json).

The Android scanner accepts this pairing format for new enrollment. Existing
saved bearer grants remain usable until expiry/revocation; `network qr` remains
a legacy bearer export. Neither stored access nor missing/corrupt keys are
silently replaced. Recovery currently has no delete or replace control.

Microphone permission is separate. A cold launch with saved access makes one
automatic call attempt; failures require explicit retry. Back navigates to
connections while the foreground-service-owned call continues. Disconnect and
notification Hang up end it. See [call navigation](android-call-navigation.md).

## Methods

| Method | Parameters | Authority / effect |
| --- | --- | --- |
| `discover` | none | Read-only busy/workspace/thread discovery |
| `observe` | none | Read-only lifecycle snapshot and subsequent observations; cannot become owner |
| `call` | `{clientId: UUID}` | Reserve one exclusive call until this connection closes |
| `input` | `{action:"mute",target:"mic"|"speaker",muted:boolean}` or `{action:"hold"|"release"}` | Owner only; update server-authoritative mute gates |
| `client-media` | Media message below | Owner only; session-correlated signaling to active runtime |

Call acceptance means reservation, not live audio. `state.phase` progresses
through `waiting-ready`, `negotiating`, `live`, `failed`, `stopped`.
`state.available` indicates call availability; each channel has persistent
`muted` and computed `effectiveMuted`. Only `effectiveMuted` drives devices.
Observers receive `availability: idle|connected|closing|unavailable`, exact
owner correlation and verified conversation identity. A closing call must finish
cleanup before a successor is admitted; a cleanup failure poisons admission.

`state.codingActivity` is `working`, `blocked`, `idle` or `unknown`. It describes
observed native work on the root and verified direct coding-agent children,
without tool text, transcripts or thread identifiers. Known work takes priority;
incomplete observations remain unknown. Blocked means waiting for approval or
input, not productive Thinking. This does not claim access to model cognition.
Runtime replacement discards the old observation; voice-only renewal preserves
activity while its coding runtime survives. Android clears it on call/media loss.

## Media negotiation

| Direction | Message | Meaning |
| --- | --- | --- |
| Server → client | `{type:"prepare",sessionId}` | Create a peer for this session; obtain local media permission if needed |
| Client → server | `{type:"offer",sessionId,sdp}` | One gathered SDP offer for the pending session |
| Server → client | `{type:"answer",sessionId,sdp}` | Apply to that exact peer only |
| Client → server | `{type:"connected",sessionId}` | That peer reached WebRTC connected, not merely answer receipt |
| Client → server | `{type:"failed",sessionId,detail}` | Bounded failure report, without private diagnostics |
| Server → client | `{type:"close",sessionId,reason?}` | Close this peer, not the call connection or device permission |

The browser bridge additionally projects authoritative state as
`{type:"state",sessionId,mic,speaker}` and accepts session-scoped mute/hold/release
messages that it translates to `input`. It does not implement separate policy.

The server serializes native offers, correlates pending sessions, bounds retries
and renews before the upstream ceiling. A client may retain one live peer and one
pending peer; replace the live peer only after the successor connects. Old
session messages and completions are ignored. Runtime replacement changes the
media session but preserves call ownership, exact conversation and transcripts.

Local microphone and speaker start effectively muted. A client disconnect must
immediately mute, stop capture/playback and close every peer even if the server
is unavailable. Close during permission or SDP setup must fence late completions.
Call reconnect is explicit: never replay controls, prompts or speech automatically.

## Preserved interfaces

Lifecycle restart/redial, native interaction and transcripts retain their existing
controller, attachment and event APIs. They are not arbitrary client-side Codex
access. A future native Android UI can implement the media contract without
porting the terminal renderer, the browser page or server internals.
