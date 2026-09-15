# 0073: Parallel workspace web readers

Accepted 2026-09-15 for disposable test sessions alongside the running production
server and Android client. Extends the default-reader selection in
[0057](0057-responsive-web-transcripts.md) without changing the exact-thread input
boundary in [0062](0062-web-text-interaction-without-voice-attachment.md).

## Decision

Add `agentvoice serve --workspace <dir> --name <label>`. Canonicalize the existing
workspace at CLI launch and bind the reader to its existing workspace-hashed
frontend socket. An absent explicit socket stays offline, never falls back to the
default endpoint, and observation must report the selected workspace. Default
`serve` retains the default endpoint and `https://agentvoice.localhost`.

A reader name is a validated single DNS label for the existing loopback portless
proxy. An explicit workspace requires a non-default name so the ordinary test
invocation cannot take the production route. The configured exact origin controls
Host/Origin admission, Vite allowed hosts, HMR and CSP. Wildcard local origins,
browser-selected workspaces and native credentials in browser code remain forbidden. Host pending-input queues
for explicit readers use canonical-workspace-hashed storage; the default endpoint
retains its legacy queue file for recovery. Origin renaming does not change queue
identity, and no explicit reader reads or rewrites the default queue.

Separate server processes are the current session container. Existing workspace,
controller and thread identities remain authoritative; reader deployment names
never become session identity. No server lifecycle, network gateway, media,
role/config or native-child semantics change. Future session switching must retain
exact identity fencing, rather than deriving authority from an origin label.

## Verification and delivery

Fake sessions sharing one state root verify simultaneous default/named reading,
separate persistence scopes, missing-socket refusal and survival of test shutdown.
Origin tests reject cross-reader requests; isolated dev and production-preview
HTTP/TLS fixtures verify named origins without operating the shared proxy. CLI
checks reject invalid/reserved targets before route startup. Activation of real
servers, clients and reader routes is separate from source delivery; see the
[parallel workflow](../parallel-test-environment.md).
