# AgentVoice client API, version 2

The production client/server boundary is **session control, never media**.
`src/frontend/protocol.ts` and `media-protocol.ts` own the Zod contracts;
`connectFrontend` is the TypeScript client. The browser bridge and native
terminal client use that same client. No platform selector is sent.
`client.schema.json` is the generated JSON Schema for non-TypeScript clients;
regenerate with `bun scripts/generate-client-schema.ts`. A drift test pins it.

## Transport and authority

Current transport: UTF-8 newline-delimited JSON on an owned mode-0600 Unix socket
under the private AgentVoice state directory. Each request has
`{v:2,type:"request",id,method,params?}`. Responses correlate `id` and return
`{v:2,type:"response",id,ok:true,result}` or `ok:false,error:{message}`.
State updates are `{v:2,type:"state",state}`; media events are
`{v:2,type:"client-media",message}`. The control-plane socket framing cap is
1 MiB; SDP strings are capped at 192 KiB, peer IDs are UUIDs, failure details
at 256 characters. No SDP is included in diagnostics, events or transcripts.

The socket's OS ownership is authentication. `clientId` and `sessionId` are
correlation, not authentication. There is no arbitrary-network endpoint flag.
The future desktop-to-Android transport needs authenticated encrypted access
and bounded disconnect detection; it must not expose this private socket or
reuse the prototype URL as remote authentication.

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
