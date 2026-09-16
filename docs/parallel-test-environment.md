# Parallel production and test sessions

Keep the installed default server and Android call running. Use a separate source
checkout and a distinct existing workspace for the disposable test server. No new
server mode or permanent named-agent registry is needed: each server still owns
one workspace session, and each reader is pinned to one server endpoint.

## Preparation (no call or service changes)

From a clean owned test checkout, install its dependencies and build its client
media library if pointer-client changes need a fresh library:

```sh
bun install --frozen-lockfile
npm --prefix web ci
bun run native:build
mkdir -p "$HOME/.local/state/agentvoice/test-workspace"
```

Do not use the production conversation workspace, copy its `.agentvoice-session`,
or run the full installer to update a test checkout. The test workspace keeps its
own marker, native root, role binding and voice transcript. To test a fresh root,
use another new workspace. Stopping/restarting the test server normally resumes
its existing marker. Native history and transcripts are retained after shutdown.

## Explicit activation

Run each foreground process in its own terminal, from the intended checkout.
These commands start real runtime/media activity; schedule activation separately
from source preparation when a live call or human-controlled resource is involved.

Production reader, if it is not already running (installed production source):

```sh
agentvoice serve
# https://agentvoice.localhost
```

Test server, from the test checkout:

```sh
bun run src/main.ts server --workspace "$HOME/.local/state/agentvoice/test-workspace"
```

Test pointer client, from that same checkout:

```sh
bun run src/main.ts client --workspace "$HOME/.local/state/agentvoice/test-workspace"
```

Test reader, from that same checkout:

```sh
bun run src/main.ts serve --workspace "$HOME/.local/state/agentvoice/test-workspace" --name agentvoice-test
# https://agentvoice-test.localhost
```

The two readers can run together. `--production` selects built assets from that
reader's checkout (`npm --prefix web run build` first); it does not select the
production voice server. `--workspace` selects the socket, while `--name` selects
the local web origin. An explicit workspace requires a name other than the
reserved default `agentvoice`. Names are single lowercase DNS labels. Names and
workspace selection stay host-side; neither URLs nor browser input select native
threads, sockets or credentials. Reusing an existing name is a route conflict;
choose a distinct name and do not replace a reader the human is using.

Closing the test client ends only its media attachment. Ctrl+C in the test server
ends that test session's runtime and native work. Ctrl+C in a reader stops only
that reader and its owned portless route. Rebuild/relaunch test code in its own
checkout; leave production source, server and reader processes untouched.

## Targeted Android pairing

Network settings, device records and the private pairing socket are scoped to the
canonical workspace when `--workspace` is present. This lets the supervised test
server expose its own Android endpoint without reading or changing the default
server's settings or paired devices. It needs a dedicated trusted WSS proxy route
and an unused loopback port; do not reuse production's endpoint or backend port.
Configure that target from the test checkout before restarting only the test
server with the updated source:

```sh
bun run src/main.ts network configure \
  --workspace "$HOME/.local/state/agentvoice/test-workspace" \
  --endpoint wss://greybird.taile9945f.ts.net:48415/v2/client \
  --port 44415
```

The reserved tailnet-only test route is HTTPS port 48415 to
`http://127.0.0.1:44415`. Prepare and verify that Tailscale Serve route separately;
the AgentVoice command neither creates nor changes it. Production remains on
48414 to 44414.

The installed supervised jobs use workspace
`$HOME/.local/state/agentvoice/test-workspace`, server label
`io.arthack.agentvoice-test.wait`, reader label
`io.arthack.agentvoice-test.serve`, and reader origin
`https://agentvoice-test.localhost`. Once its dedicated proxy and updated server
are running, generate the one-use QR from the same checkout:

```sh
bun run src/main.ts network pair \
  --workspace "$HOME/.local/state/agentvoice/test-workspace"
```

The command canonicalizes the workspace and verifies the exact live server before
opening its private pairing socket. If the supervised test server is stopped,
still runs source without workspace-scoped pairing, or has not loaded its network
configuration, the command fails. It never falls back to the default server.
Use the same selector for management:

```sh
bun run src/main.ts network status --workspace "$HOME/.local/state/agentvoice/test-workspace"
bun run src/main.ts network list --workspace "$HOME/.local/state/agentvoice/test-workspace"
bun run src/main.ts network revoke <device-id> --workspace "$HOME/.local/state/agentvoice/test-workspace"
```

## Isolation and limits

Keep the normal XDG state and CODEX_HOME environment. Existing workspace-hashed
frontend sockets, unique controller/event endpoints, workspace/thread leases,
workspace-scoped roles and transcripts separate session state. An explicit
workspace server loads a network gateway only from its own workspace-scoped
configuration. Without that opt-in it binds no Android endpoint; with it, its
settings, grants, pairings and pairing socket remain separate from the default
server. The web reader fails offline if its selected socket disappears; it never
falls back to the default server. Pending
Agent input is saved in a workspace-hashed host queue; it cannot be displayed,
resumed or overwritten by the other endpoint. The default queue retains its
existing recovery file.

On macOS the source client re-executes through the already installed signed Bun
runtime for microphone permission identity, passing this checkout's `src/main.ts`
as its source. That does not select installed application code. The native media
library is loaded from this checkout. Changing XDG_STATE_HOME would also move
runtime lookup and is unnecessary for session isolation. CODEX_HOME, login,
account capacity, machine files, configured roles and external MCP services remain
shared resources; a workspace is not a sandbox. Use `--config` and/or `--role` on
the test server only when intentionally testing other settings. Default config
and prompt files remain unchanged. A workspace with an ejected role database uses
its saved binding under the existing role rules.

The shared loopback HTTPS proxy must already be prepared. Source preparation does
not install a LaunchAgent, mutate shared proxy settings, expose another network
API, launch a browser or create a session picker. Origin labels are reader
deployment names, not server or pairing identities.
