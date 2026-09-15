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

## Isolation and limits

Keep the normal XDG state and CODEX_HOME environment. Existing workspace-hashed
frontend sockets, unique controller/event endpoints, workspace/thread leases,
workspace-scoped roles and transcripts separate session state. An explicit
workspace server never loads the default network gateway, so it neither binds the
Android endpoint nor changes its grants. The web reader fails offline if its
selected socket disappears; it never falls back to the default server.

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

The shared loopback HTTPS proxy must already be prepared. This workflow does not
install a LaunchAgent, mutate shared proxy settings, expose another network API,
launch a browser or create a session picker. A future multi-session server can
replace endpoint discovery behind the same verified workspace/controller/thread
identity boundary; origin labels are reader deployment names, not session IDs.
