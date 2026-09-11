# 0046: Pair phones with durable device keys

Accepted September 11, 2026 by the operator. Extends
[0034](0034-authenticated-client-network.md) and replaces
[0045](0045-native-pair-phone-preview.md)'s inert preview payload. It does not
change call ownership, media placement, frontend API framing, Android navigation,
or the legacy grant format.

## Decision

**Pair phone…** and `agentvoice network pair` create a five-minute, one-use
enrollment capability and show it as a QR code. The code registers a phone-owned
P-256 public key. A successful pairing has no time-based expiry: it remains valid
until explicitly revoked. The short QR lifetime limits exposure of the enrollment
bearer; it is not the lifetime of the paired phone.

Pairing is authentication only. Preparing, displaying, redeeming or verifying a
device never connects to the frontend socket, reserves a call, starts Codex,
opens audio, or requests microphone access. The phone separately decides when to
start a call after it has persisted the successful pairing.

The server exposes a private mode-0600 Unix socket at
`network/pairing.sock` for the native menu and CLI. Its version-1 NDJSON methods
are `prepare`, `activate`, `status` and `cancel`. `prepare` persists only hashes
of the enrollment secret and an independent local receipt. A producer activates
the enrollment only after it has successfully rendered the QR. Closing the window,
terminal interruption, or output failure requests cancellation of an unredeemed
enrollment; ambiguous transport loss or process termination can leave it active
only until its five-minute server deadline.
Prepared, active and completed records survive a server restart; incomplete
records expire after five minutes.

The QR is canonical compact UTF-8 JSON prefixed with
`agentvoice-pair:v1:`:

```json
{"v":1,"endpoint":"wss://voice.example:48414/v2/client","enrollment":"<32hex>.<64hex>","expiresAt":1800000300000}
```

The endpoint retains the existing strict `wss` `/v2/client` authority. The phone
derives `/v2/pair` and `/v2/auth/challenge` on the same verified TLS authority;
the QR cannot select alternate hosts, insecure transport, redirects, or a
certificate bypass. `expiresAt` is display guidance only—the server's persisted
deadline is authoritative.

## Enrollment and recovery

The phone creates a non-exportable Android Keystore P-256 signing key, persists
its pending request tuple before its first request, and sends strict JSON no
larger than 4096 bytes:

```http
POST /v2/pair
Content-Type: application/json

{"v":1,"enrollment":"<id.secret>","requestId":"<lowercase UUID>","label":"Pixel 9","publicKey":"<base64url SPKI DER>"}
```

Labels are NFC Unicode, one to 80 Unicode scalar values, with Unicode control
characters rejected. Public keys must be the exact 91-byte DER SubjectPublicKeyInfo
encoding of an uncompressed `prime256v1` point. Alternate curves, compressed
points, explicit parameters, trailing DER and non-canonical base64url are refused.

The initial response is `201`; an exact response-loss recovery is `200`:

```json
{"v":1,"deviceId":"<32hex>","serverId":"<persistent UUID>"}
```

The successful response is recoverable for 24 hours using the same enrollment
secret, request ID, normalized label and public-key fingerprint. A different
tuple cannot reuse the consumed enrollment. The paired-device record is created
before success is returned, so a lost response or process restart cannot create
a second identity. A new enrollment of the same active public key returns its
existing device identity; a revoked key cannot silently re-enroll.
Invalid enrollment credentials are globally limited to 32 attempts per
10-second window. Once full, redemption returns `429 pairing_limited` until the
window clears; the limit is deliberately not source-IP based because the TLS
proxy is the only direct peer.

## Connection proof

A paired device requests a memory-only, one-use 30-second challenge:

```http
POST /v2/auth/challenge
Content-Type: application/json

{"v":1,"deviceId":"<32hex>"}
```

The response contains a 16-byte `challengeId`, a 32-byte nonce, `expiresAt`, and
`serverTime`, with binary values encoded as unpadded base64url. There are at most
four outstanding challenges per device and 256 globally. Unknown-device
challenge attempts are globally limited to 64 per 10-second window. A server
restart simply requires a fresh challenge; it does not remove a pairing.

The device signs `SHA256withECDSA` over this exact byte string:

1. ASCII `AgentVoice device-auth v1` followed by one NUL byte.
2. Seven fields, each encoded as unsigned 16-bit big-endian byte length followed
   by its bytes: lowercase `deviceId`, base64url `challengeId`, decoded nonce,
   ASCII `GET`, canonical endpoint authority, ASCII `/v2/client`, and ASCII
   `agentvoice.v2`.

The strict ASN.1 DER signature is sent unpadded base64url in the WSS upgrade:

```http
GET /v2/client
Sec-WebSocket-Protocol: agentvoice.v2
X-AgentVoice-Auth: 1
X-AgentVoice-Device: <deviceId>
X-AgentVoice-Challenge: <challengeId>
X-AgentVoice-Signature: <signature>
```

Bearer and signed headers cannot be mixed. The server reserves a challenge while
verifying it, consumes it only after successful upgrade, and otherwise releases
the reservation for one exact retry. Every later frame and heartbeat rechecks
revocation through the existing network authority boundary. Revocation closes an
active paired connection on the existing heartbeat bound. A `device_revoked`
upgrade response is emitted only after a valid signature proves possession of a
key that was revoked after its challenge was issued; unproved failures remain
indistinguishable as `device_auth_failed`.

The complete interop fixture, including canonical QR bytes, default-port and IPv6
authority cases, the 171 signing bytes, SHA-256, P-256 SPKI and a valid high-S DER
signature, is [pairing-v1.json](../../tests/fixtures/pairing-v1.json).

## Storage, errors and compatibility

Public-key identities live separately at `network/paired-devices/`. Their private
records contain the device ID, normalized label, SPKI, fingerprint and creation
time, but no expiry. Revocation retains a renamed record. `network list` labels
these as `paired-device`; `network revoke <id>` accepts either kind.

Protocol-valid pairing and challenge POST failures are bounded, secret-free JSON
with `Cache-Control: no-store` and a matching `X-AgentVoice-Error` code. Generic
route, Host and Origin rejection intentionally retains an empty generic HTTP
response. Pairing uses `400 invalid_request`,
`401 invalid_enrollment`, `409 enrollment_not_ready`,
`409 enrollment_consumed`, `409 device_unavailable` for a previously revoked
key, `429 pairing_limited`, and `503 pairing_unavailable`. Challenge issuance
uses `400 invalid_request`, `404 device_unavailable`, `429 challenge_limited`,
and `503 pairing_unavailable`. Failed signed upgrades have no body: they use
`401 device_auth_failed`, `403 device_revoked`, or `503 pairing_unavailable`
with only the bounded header and no-store policy. Errors never identify which
proof component failed.

Existing `agentvoice-grant:v1` QR codes, 30-day bearer profiles,
`Authorization: Bearer`, grants already encrypted on phones, WSS path and
subprotocol, frontend API version 3 frames, heartbeat version 2 frames, and
single-call admission remain compatible. `agentvoice network pair` is the new
interactive durable workflow. The older `agentvoice network qr --name` remains
the explicit legacy/export workflow and does not change existing credentials.

## Consequences

Ordinary users pair once instead of renewing an exported bearer every 30 days.
They still need an explicit device-management surface or `network revoke` to end
that trust. Anyone who obtains an active QR can win its one-use enrollment race,
so pairing remains an explicit, short-window action whose completion is shown on
the Mac or terminal. A future confirmation phrase can further harden screenshot
leakage without changing the durable-key foundation.
