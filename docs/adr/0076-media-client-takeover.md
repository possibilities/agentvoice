# 0076: Replace media clients through server-owned admission

Accepted September 15, 2026 at the operator's request. Extends the one-media-owner
rule in [0053](0053-retain-workspace-session-across-frontend-detach.md) with explicit
replacement policy. Its retained workspace session, acknowledged detach, poison
and no-replay boundaries remain unchanged.

## Decision

A terminal `agentvoice client` connection automatically replaces the current media
client. The native Android client first asks the server whether replacement is
needed and, when occupied, shows an explicit confirmation. Cancel leaves the
existing client untouched. This also applies to Android's cold-launch attempt.

The server owns arbitration on the same frontend socket used by local and WSS
clients. Frontend API v3 adds `call.takeover`: `auto`, `confirm`, or `{token}`.
Omission keeps legacy busy rejection. An idle call is admitted normally; a
`confirm` request against an occupied server returns a confirmation challenge,
not media ownership. Confirmation uses that token on the same connection.

A challenge is bound to its requesting connection, client ID and the exact
incumbent attachment, with bounded lifetime. An expired or superseded challenge
cannot evict a newer owner: if media remains occupied, another confirmation is
required. Cancellation closes the candidate connection without touching the
incumbent. Challenge requests do not reserve media or interrupt it.

Replacement reserves one admission before asynchronous work, fences the old
attachment against input and signaling, releases its transient hold, closes its
transport and awaits acknowledged media detach. Only then may the waiting client
own a fresh attachment. Concurrent candidates cannot share admission. A candidate
that disconnects while waiting cannot later become owner. Unknown native stop
outcomes retain native work and poison subsequent media admission, with a truthful
failure returned to the requester.

Replacement reuses the exact retained Call/controller/runtime, pinned workspace,
root thread, native child, work, mailbox and gateways. It neither resumes a new
thread nor submits a turn, restarts the runtime, reloads prompts or replays input.
Persistent mute assignments survive; new media performs fresh negotiation.

## Verification and delivery

Fake socket/media tests cover automatic replacement, confirmation/cancel,
simultaneous requests, stale confirmations, disconnected candidates, detach
failure and retained conversation identity. Android unit/build checks cover the
confirmation lifecycle and request fencing. These checks do not establish actual
device audio behavior. Activating new server code requires an explicitly scoped
server restart; Android installation and live device validation require their
own resource handoff. Building or publishing a command does not prove that an
already running server has loaded the new arbitration.
