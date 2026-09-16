# 0081: Saved Android server profiles

Status: Accepted
Date: 2026-09-16

Extends [0046: Durable device pairing](0046-durable-device-pairing.md),
[0073: Parallel workspace web readers](0073-parallel-workspace-web-readers.md),
and [0076: Media client takeover](0076-media-client-takeover.md).

## Context

One phone needs to retain access to the normal server and an independently
running test server. Replacing the only saved credential would destroy useful
access, and letting two phone connections overlap would obscure who owns audio.
A terminal pairing command also needs an exact server target rather than an
implicit production enrollment.

## Decision

Android keeps one encrypted, atomic, no-backup collection of server profiles and
a selected profile ID. Every profile has a stable internal ID; presentation uses
**Server 1**, **Server 2**, and so on in saved order. Numbers are projected again
after forgetting an entry, so no naming/editing preferences or gaps are introduced.
The endpoint authority distinguishes servers, including different ports on one host.

The connection screen lists saved profiles, their current state, a connection
action and **Forget server** in each row's options. **Add server** opens the existing
QR scanner. Forgetting requires confirmation, disconnects that profile if active,
and removes its local profile only; it does not revoke the server's device record.
No credential, enrollment secret, device ID or signing alias appears in the UI.

Enrollment still persists its exact request and nonexportable signing-key alias
before sending anything. At most one new pairing is pending; existing profiles
remain usable while it waits for explicit retry. Pairing never changes the selected profile or starts a call; successful enrollment
returns to Connections. Only explicit **Connect** establishes selection, including
for the first paired server. Forgetting the selected entry clears selection rather
than silently choosing another server. Duplicate canonical endpoints are rejected before key
creation. Explicit enrollment through a different endpoint remains a separate
profile even when its authenticated server identity matches an existing profile;
its key and device ID are retained without replacing either profile.

The first collection transaction imports existing bearer and durable pairing state
without rewriting or deleting those files or keys. Once present, even an empty
collection is authoritative; forgetting cannot resurrect an old profile. Corrupt
or conflicting state fails closed. Listing metadata does not open a signing key;
unavailable access can be retained while another profile remains usable.

The call owner records the attempted profile ID across Activity recreation. An
explicit connection to another profile closes the old transport, gates and local
media before starting the successor. Late callbacks and notification actions
remain fenced by the existing call generation and incarnation. Destination-server
takeover still requires its current server-issued confirmation. No automatic
reconnect, enrollment replay or second call owner is added. Cold launch attempts
the last explicitly selected ready profile once; migration preserves the legacy
selection. A new profile remains unselected across background completion and fresh
process/task launch until **Connect**. An app with saved but unselected profiles
opens Connections; Activity resume/recreation after interrupted enrollment does
the same without starting a call.

The CLI adds exact `network pair --workspace <existing-directory>` targeting.
Explicit workspace servers opt in with workspace-scoped network configuration,
device/grant records and pairing sockets. The command verifies a live exact
workspace, never falls back to the default server, and keeps the existing
render-before-activation and one-use pairing capability. The default server's
existing paths and command remain compatible. Test gateway/proxy activation is a
separate operation, not a side effect of rendering a QR.

## Verification boundary

JVM tests cover collection migration, request retention, selection and switching
order; host Compose renders cover saved-list states without a phone or emulator.
Android instrumentation covers encrypted storage and the nonexportable Keystore
keys. Those instrumentation checks and real two-server switching require an
explicit phone handoff. The supervised test server also needs its documented
opt-in gateway/proxy activation before it can enroll a phone.
