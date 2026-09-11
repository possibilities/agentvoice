# Android client handoff

Implement [client API v3](client-api.md), validated by [`client.schema.json`](../client.schema.json).
Do not port server internals or call stock Codex directly. The server owns Codex
startup, login/configuration, conversation selection, leases, renewals, transcript
storage and cleanup. The Android app owns permission, audio routing, mute gates,
WebRTC and the authenticated WebSocket. Terminal and Android use the same server.

## Two proof paths

| Frontend command on the phone | Control path | Codex and saved transcripts |
| --- | --- | --- |
| `agentvoice phone` | Loopback page → Termux bridge → private local socket | Phone's `agentvoice server` |
| `agentvoice phone --connect /absolute/private/desktop.json` | Same loopback page → Termux bridge → verified WSS over Tailscale | Desktop's default server |

The second mode requires no Termux server. The final Android app connects directly
to WSS and needs neither Termux nor this browser bridge. Audio flows between the
client WebRTC peer and the upstream voice service, not through AgentVoice or its
Tailscale proxy. Both devices need upstream Internet access.

Launching with `--connect` enables both **Phone (Termux)** and **Desktop (Tailscale)**
in the web screen's Server selector, initially selecting desktop. Without a private
profile, desktop is disabled. Switching stops the current media/call; tap Start
voice to begin on the selected server. Start or retry is always explicit. The
loopback bridge now stays available between calls until its process is stopped,
including after page loss or a revoked/failed remote connection; call teardown
still occurs on every owner disconnect. A local server must be running for Phone.
The page receives only the IDs `local`/`remote`, never an endpoint or credential.

Hold to talk always occupies the same space and is disabled unless the microphone
is persistently muted and the peer is connected. Press and hold to speak; release,
pointer cancellation, lost capture or focus/background mutes locally immediately.
Delayed server acknowledgements cannot reopen the microphone after release.

## Desktop setup and device provisioning

Install normally through AgentStart. The macOS installer supervises the waiting
default server; it opens neither Codex nor audio until an admitted `call` request.
Manual/Termux servers use `agentvoice server` in a foreground terminal. On desktop:

```sh
# Explicit first enable: requires a connected Tailscale device and unused ports.
bun ~/code/agentstart/scripts/agentvoice-network.ts --enable
agentvoice network status
# Native Android app: choose Pair phone… in the desktop menu, or:
agentvoice network pair
# Termux/native desktop client profile:
agentvoice network grant --name Android --out /absolute/private/android.json
agentvoice network list
```

The helper derives this machine's DNS name, reserves dedicated HTTPS 48414 →
loopback 44414, refuses foreign handlers/Funnel, and verifies other routes are
unchanged. Later `agentstart/scripts/install.sh --install` reconverges an enabled
route, but never enables one or grants credentials. Keep Tailscale ACLs limited to
the intended devices. Never place this route on an existing public Funnel port.

Custom trusted TLS proxies can use `agentvoice network configure --endpoint
wss://host:port/v2/client --port <loopback-port>` followed by a default-server
restart. The proxy must preserve Authorization or the `X-AgentVoice-*` proof
headers, WebSocket subprotocol, and Host. Paired-device requests require the
endpoint’s canonical authority (including non-default port); do not replace it
with the loopback backend Host. It must not log credentials, headers or frames. Do not expose the backend directly or disable certificate verification.

Grant output is create-new only, mode 0600, and contains
`{version:1,endpoint:"wss://…/v2/client",token:"<id>.<secret>"}`. Transfer only this
file through a trusted encrypted channel, never chat, clipboard logs, URLs or
browser storage. On Termux use a private app-owned directory and mode 0600.
The native Android app instead uses the desktop menu's **Pair phone…** enrollment
window and `agentvoice-pair:v1:` QR. This short-lived, one-use capability enrolls
a durable Keystore signing identity; it is not a bearer call credential. HTTPS
enrollment and challenge requests use only the QR endpoint's verified authority,
with no redirects or insecure fallback. A pending request is saved before sending
and recovered only by an explicit retry of the same tuple. See the
[client API](client-api.md#android-device-enrollment) for the pairing contract.
Existing Android bearer grants remain compatible. No Codex credential is transferred.

Grants expire after 30 days. Revoke with `agentvoice network revoke <device-id>`;
active connections close within 10 seconds, or on their next frame. File-based
clients need a new profile to renew. The native Android app currently retains
its single grant even when rejected or unreadable; it has no deletion/replacement
UI. Recovery requires manual app-data repair, then a new pairing enrollment. There is
no refresh secret. Revoke the old grant when replacing it. `network disable` retains settings under a
disabled filename; restart the default server to immediately stop network access.
Remove only its dedicated Serve route with `tailscale serve --https=48414 off`.
Changing settings requires explicit disable/configure and proxy reconciliation;
existing profiles are not silently rewritten.

## Wire contract

Use verified `wss://<desktop-tailnet-DNS>:48414/v2/client` with:

```text
Authorization: Bearer <device-token>
Sec-WebSocket-Protocol: agentvoice.v2
```

Negotiate exactly `agentvoice.v2`. Send no Origin header; browser-origin requests
are deliberately refused. Kotlin/OkHttp connection skeleton (do not log `request`):

```kotlin
val request = Request.Builder().url(profile.endpoint)
    .header("Authorization", "Bearer ${profile.token}")
    .header("Sec-WebSocket-Protocol", "agentvoice.v2")
    .build()
// Default trust manager and hostname verification; no trust-all overrides.
val socket = OkHttpClient().newWebSocket(request, listener)
```

An authenticated socket alone starts no call. On explicit Start, send:

```json
{"v":2,"type":"request","id":"1","method":"call","params":{"clientId":"11111111-1111-4111-8111-111111111111"}}
```

Use a new client UUID for every new connection/call and unique request IDs (1–128
characters), with at most 32 outstanding requests. Correlate every response.
Acceptance reserves ownership, not live media. Async state/media frames can arrive
before or between responses. Treat any malformed, incompatible, uncorrelated or
oversized message as terminal. A refusal does not authorize retry/replay.
`discover` is read-only; `observe` makes that connection permanently observer-only.
Use a separate connection for a call. Neither identity UUID grants authority.

One UTF-8 JSON text message per frame, no batches or binary messages; limit 1 MiB
and at most 256 messages per 10 seconds including heartbeats. SDP limit 192 Ki
characters; failure detail 256 characters. The gateway caps total connections at
16 and per credential at 4, and closes slow readers instead of growing queues.

The server sends an immediate application heartbeat and then at roughly 10-second
intervals after each reply:

```json
{"v":2,"type":"ping","nonce":"0123456789abcdef0123456789abcdef"}
{"v":2,"type":"pong","nonce":"0123456789abcdef0123456789abcdef"}
```

Reply immediately with the exact nonce. These are JSON messages, not WebSocket
control ping/pong. Server timeout is 20 seconds, checked every 10 seconds; clients
must independently stop audio and close if no valid ping arrives for 30 seconds.
Other traffic does not reset liveness. No automatic reconnect or queued sends.

| Failure | HTTP / WebSocket status | Client action |
| --- | --- | --- |
| Bad/expired credential on upgrade | 401 | Reprovision; do not log credential |
| Origin/path, Host, protocol rejected | 404, 421, 426 | Fix endpoint/client configuration |
| Connection capacity | 429 | Show unavailable; explicit retry |
| Revocation or expiry | 4403 | Stop media; replace grant |
| Heartbeat timeout | 4408 | Stop media; explicit reconnect |
| Invalid JSON/API/binary/heartbeat | 4400 | Stop; protocol error |
| Rate, pending or duplicate IDs | 4429 | Stop; fix client limits |
| Slow reader / oversized output | 4413 | Stop; clear queues |
| Oversized input | 1009 | Stop; fix frame limit |
| Local server ended/unavailable | 1011 / 1013 | Stop; explicit retry after service recovery |
| Shutdown / normal closure / transport loss | 1001 / 1000 / 1006 | Stop; explicit new call only |

Close codes are diagnostic, never proof that the server received a last command.

## Media and lifecycle implementation

Start with capture and playback effectively muted. Ask microphone permission only
after Start. On `prepare`, allocate a session-scoped peer, add one audio track and
the `oai-events` data channel, create an offer, set local description and wait for
ICE gathering completion. Send one gathered SDP `offer` through `client-media`;
there is no trickle-ICE method. Apply an `answer` only to its matching pending peer.
Report `connected` only after WebRTC is connected, not after setRemoteDescription.
The server handles retries and renewal; clients must fence stale async completions
and close superseded peers. Never replay media offers after reconnect.

Treat `state.mic.effectiveMuted` and `state.speaker.effectiveMuted` as the authority
for local devices. Muting locally may be immediate; unmuting waits for server
confirmation. PTT release/cancel/blur must clear the hold. App stop, permission
revocation, network loss or heartbeat failure must immediately mute, stop capture
and playback, close all peers and close/cancel WSS—even if no server is reachable.
The Android call is owned by a private microphone foreground service. Back,
backgrounding and locking release held PTT but retain that call; Activity
recreation binds to the same controller. Disconnect or notification Hang up
ends it. The notification also offers microphone Mute/Unmute and return-to-call.
Process death never automatically reopens media. See
[call navigation](android-call-navigation.md) for the lifecycle and permission policy.

Call disconnect closes server-owned Codex and work; the waiting server survives.
Cleanup must complete before another call is admitted. Reconnect means a new call
under server conversation-selection settings, not an implicit resume of the last
thread. In-call server restart/redial retains the owner connection and changes
media sessions; close only peers named by stale/close events, not their successors.

## Handoff acceptance

Automated tests cover private grants, expiry/revocation, hostile handshake/frame
input, shared local/network exclusivity, observer restrictions, relay and teardown,
and verified TLS through a real TLS proxy for both the native client adapter and
loopback browser bridge. The TLS fixture also proves an untrusted certificate
cannot start a call. These use fake calls and do not prove audible playback.

Desktop/phone proof on 2026-09-08: the installed ARM64 Termux client reached
WebRTC connected against both its local server and the desktop over Tailscale.
For the latter, desktop observation reported `live` with a desktop-owned Codex
0.153.4 child while the phone's local server had no runtime. Revoking the test
grant ended the browser connection, returned the desktop to idle and reaped its
owned runtime/Codex child. The revoked grant could not reconnect. The desktop
saved the matching recording with start and end markers. No human audio-heard
claim is made from this transport-only run.

Native developers should run on-device tests for permission denial/revocation,
audio focus/route changes, Bluetooth, lock/background, Wi-Fi↔cellular/Tailscale
loss, silent half-open connection, token revocation during negotiation, server
restart, stale SDP/peer callbacks and explicit reconnection. Check the desktop
thread/process identity and saved voice JSONL, not just a connected indicator.
Finish with a human spoken request and audible answer. Browser audio success is
not evidence that a native WebRTC/audio implementation works.
