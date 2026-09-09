# 0032: A loopback browser may own phone media

Accepted September 8, 2026. Extends [ADR 0024](0024-server-and-pointer-frontend.md) without replacing its terminal
topology or restoring the remote console retired by [ADR 0002](0002-remote-console-attaches-to-client.md)–0005.

The terminal-media asymmetry below is superseded by [ADR 0033](0033-client-owned-native-media.md): both clients now
own media. This ADR still governs the same-device browser proof's security boundary.

## Decision

`agentvoice phone` is a second call-owning frontend for a browser on the same
Android/Termux device. It starts an ephemeral HTTP/WebSocket listener bound only
to `127.0.0.1`, prints and opens a random capability-bearing URL, and waits for
one browser owner. The user must tap Start before the page requests microphone
access or connects the AgentVoice frontend call.

For this call type the browser owns microphone capture, speaker playback,
codecs and its `RTCPeerConnection`. The voice runtime continues to own the stock
Codex child, exact thread and workspace, configuration, delegation, transcripts,
attachments and realtime signaling authority. The browser sends its SDP offer
through the frontend/controller/worker path and receives the matching answer;
media travels directly over WebRTC and no RTP, Opus or PCM crosses controller
IPC. Browser mute and hold messages use the same controller mute gates as the
pointer frontend.

This creates an intentional asymmetry. `agentvoice client` remains a pointer-only
OpenTUI frontend while its server runtime owns miniaudio, Opus and WebRTC.
`agentvoice phone` owns browser media because Android's browser permission and
audio stack are the supported boundary. Do not move native terminal media into
its frontend merely for symmetry, and do not make the phone page depend on the
native duplex library. A future unified client-media protocol may make both
frontends symmetric, but it must preserve the ownership, lifecycle and security
invariants below and requires a separate decision.

## Lifecycle

The browser WebSocket owns the frontend call. Closing or navigating away from
the page, losing its socket, or terminating `agentvoice phone` closes the
frontend, releases any hold, tears down browser media and the server-owned
runtime/Codex child, then lets the waiting server accept another call. Startup
and teardown serialize so a page closed during call allocation cannot leak a
late runtime. Only one browser owner and one workspace call are admitted.

Each WebRTC negotiation has an unguessable session identifier. Offers, answers,
connection reports, failures and mute state apply only to the current session;
stale messages cannot mutate its successor. Redial, timed renewal and full
runtime replacement retain the browser frontend while replacing the appropriate
media session or runtime. They do not change the pinned workspace, thread lease,
controller endpoints or transcript rules.

## Security boundary

The page server binds an ephemeral port on `127.0.0.1` and has no bind-address,
remote-host or arbitrary-endpoint option. A 256-bit random token is embedded in
the path. Requests require the exact loopback Host; WebSocket upgrades also
require the page's exact Origin and exclusive owner reservation. Methods, paths,
body size, WebSocket frame size and all protocol messages are bounded and
validated. Responses disable storage and framing and constrain scripts,
connections, media and permissions with explicit browser headers.

The URL is therefore a short-lived bearer capability: print it only so the same
device can open it, never persist it in configuration, logs or discovery, and do
not share or bookmark it. Plain HTTP is confined to the browser's loopback secure
context. Do not add LAN, tailnet, ADB-forwarded or cross-machine access by
loosening Host/Origin checks, rebinding the listener, or treating the token as a
remote authentication design. Native Codex and controller capabilities remain
private and are never delivered to the page.

## Android build and limits

`bun run android:build` cross-compiles `dist/agentvoice-android-arm64` with Bun's
`bun-linux-arm64-android` target. The artifact embeds AgentVoice and its runtime,
but not Codex authentication, configuration or history; it expects stock Codex
on the Termux PATH or through `CODEX_PATH`. Building does not install the binary,
grant browser microphone access or start inference. Browser-media calls do not
load native audio. The standalone worker dispatch must stay inside the compiled
executable rather than attempting to execute virtual `/$bunfs` source paths.
The separate explicit `scripts/install-android --install --host <ssh-target>`
contract deploys only this artifact to an already prepared Android ARM64 Termux
target. Its private receipt and SHA checks guard reruns and upgrades; desktop and
unattended installation never contact the phone.

The first implementation provides voice controls only. Agent and transcript
views remain separate local attachments, and the page has no remote-control,
arbitrary server attachment, service installation or account-management role.
Tests with fake browser signaling establish bounds and lifecycle, not Android
microphone fidelity, audible playback, browser echo processing or live service
compatibility.
