# Live Voice | Agent transcripts

`agentvoice serve` opens a live web view at **https://agentvoice.localhost**.
Two equal, full-height lanes use `@agentchats/transcript` with Human / Agent labels,
Markdown and inline tool/diff disclosures. There is no toolbar or call control.
The Agent lane includes the shared text composer with Send, Steer, Queue and Stop;
the Voice lane has no composer. Stop interrupts Agent work, not the voice call.
Both lanes always watch, open at the latest message and follow new text. Scrolling
up lets you read earlier text and shows the shared jump-to-latest chip with a count
of new messages. Using the chip or scrolling back to the bottom resumes following.

The view observes the existing **default local AgentVoice server**, independent of
the launch directory. A missing server shows “No agent voice server to connect to.”
An idle server shows “Waiting for a call.” It reconnects automatically, including
after call end, a new call, runtime replacement or an explicit new session.
Closing the page or `serve` leaves the call running.

## Prepare and run

Requires Bun, Node.js 24+, npm, and the shared loopback portless HTTPS proxy.
From this checkout, prepare dependencies once (or after changing lockfiles):

```sh
bun install --frozen-lockfile
npm --prefix web ci
agentvoice serve                 # editable Vite dev + HMR
```

From an uninstalled checkout, use `bun run src/main.ts serve`. The normal desktop
installer still owns the CLI, menu app and voice-server service; web dependencies
are prepared separately in this first slice. `serve` never installs dependencies,
builds assets, starts a voice server or starts a call.

The shared proxy must already be running on loopback port 443. Its one-time
interactive setup is `portless service install` (or `portless proxy start`), with
local CA trust completed. `portless doctor` checks it. AgentStart owns that shared
setup. The app uses its locked portless 0.15.6 dependency and never prompts for sudo
or updates the hosts file. Safari may need an explicit `portless hosts sync` after
route registration. Duplicate routes fail without taking over an existing view.

```sh
bun run web:dev                  # direct loopback development
bun run web:build
agentvoice serve --production    # Vite preview of prepared web/dist
```

Production remains optional. Both Vite modes use the same API bridge. The named
route is fixed across worktrees. Backend listeners bind strictly to `127.0.0.1`
at portless's assigned `PORT`; HMR uses the same HTTPS origin. LAN, tunnels and
wildcard routes are disabled. TERM, INT and HUP stop the foreground process tree
and unregister its route. A static hosted build cannot connect to local sockets.

## Connection and transcript contract

`GET /api/live` returns the two host-owned message arrays and a browser-only view
ID. Browsers serialize reads about once per second. One shared adapter deduplicates
concurrent reads, observes the private frontend and discovers the exact live
workspace/thread controller through its verified status. Read-only discovery also
accepts control protocol 5 so an existing call need not restart to open this view;
all other CLI discovery keeps the current protocol requirement. The browser cannot select
a workspace, thread, path, endpoint or RPC method. Native sockets, descriptors,
credentials and grants remain in the local process. Requests require a loopback
peer and exact direct-loopback or named HTTPS origin; foreign hosts/origins are
refused. Remote Markdown images and embeds are blocked.

The Voice lane incrementally tails the same private, identity-checked JSONL used
by `attach voice`, including saved speech from previous calls on this exact thread.
Draft deltas update stable item IDs; canonical completions replace them. Runtime
and realtime-session IDs fence reused item IDs. Recording gaps remain visible.
Recording reads retain the existing 64 MiB file / 1 MiB record limits. Observed
times describe transcript receipt; they do not prove when speech was heard.

The Agent lane uses event protocol 2: subscribe first, validate `state.get`, then
read `conversation.live.get` and page `conversation.items.list` newest first.
Native history loads in the background, one bounded page per read, merged by turn
and item ID. Pages accumulate privately until the pass finishes or reaches the
viewer limit, then publish together. While the first pass loads, live items and a
single loading notice remain visible; its publication resets only the Agent lane
to the end without animated scrolling. Later refreshes retain the published history
until their replacement is ready. Complete live projection items replace overlapping history; partial
live text cannot overwrite canonical history. Completion, gap and revert events
invalidate history; reverted content is cleared. A reconnect loads a new exact
snapshot, so there is no ambiguous delta replay. Every response and late history
page is fenced to the call and runtime generation. History is bounded to 10,000
items / 8 MiB with a visible notice. Unknown times are omitted. Native reasoning
stays hidden, matching the shared transcript renderer. This view neither reads
Codex databases directly nor resumes threads, answers approvals,
loads launch configuration, starts media or changes server protocols.

## Agent input

`POST /api/agent` accepts only named composer actions, a current view ID and a
unique request ID. The host discovers the exact live controller and acquires the
same identity-fenced attachment gateway used by `attach agent`. It sends native
`turn/start`, `turn/steer` with `expectedTurnId`, or `turn/interrupt` with the active
turn ID. It does not override native settings or answer approval requests; attach
the stock TUI for approvals. Mutation bodies require same-origin JSON and bounded
text. No native endpoint, token, method selector or thread selector reaches the browser.

Idle input sends immediately. While Agent works, the shared desktop-style mode
menu defaults to Steer; Queue saves a FIFO follow-up for the next idle turn.
Rows support Steer, Edit and Remove. Editing holds the row until the awaited
save/cancel handshake releases it. Stop pauses queued work and remains stopping
until the native terminal event. Resume explicitly releases paused rows.

The host saves at most 20 queued messages (64 KiB each) in private mode-0600
`web/queued-messages.json` under AgentVoice state. Restart or call replacement
restores them paused for review. Failed dispatch stays paused; unknown acceptance
never retries automatically. Check native history before editing/removing a row
whose delivery is unknown. Direct-send failures preserve the browser draft, and
only native history creates transcript messages. Request IDs deduplicate a bounded
in-process window; they are not a durable native exactly-once guarantee.

See [Agent input semantics](../docs/web-agent-input.md) for source evidence and
turn/queue boundaries.

## Shared package

The packed MIT package in `vendor/` comes from agentchats main, based on `e973c55`
plus the first-consumer fixes recorded in [vendor/README.md](vendor/README.md).
`package-lock.json` verifies its integrity. No adjacent checkout is needed to
install, build or run. UI imports use only the package's public data, React and
scoped stylesheet exports, with no aliases into agentchats internals.

The host supplies complete snapshots to `Transcript`: older native history can
arrive before existing messages, and reverts can remove messages. Those changes
exceed the append/replace semantics of `TranscriptSource.poll`, so a host-owned
snapshot is the appropriate public API. Stable IDs preserve inline disclosures.

## Future launchd ownership

Match agentchats with an AgentStart-owned `io.arthack.agentvoice.serve` resident
job invoking `~/.local/bin/agentvoice serve`. Supply the target user's `HOME`,
existing `XDG_STATE_HOME` when configured, and a `PATH` containing Bun and Node.
Use the clean canonical main checkout's CLI link; no working directory is needed.
Prepare dependencies before registration; restarts must not install or build.
Keep stdout/stderr attached to launchd logs. This is separate from the existing
AgentVoice-owned `io.arthack.agentvoice.server` call service and menu app.
This change implements the foreground entry point, not a launchd installer.

## Verification

```sh
bun run typecheck
bun run lint
bun run test
bun run web:check
bun run web:test
```

The API tests create disposable private frontend/control/event sockets with fake
calls and saved voice records. They cover ordering, canonical replacement, late
responses, call ownership and teardown. Dev and preview tests use the real portless
HTTPS proxy library with a temporary certificate on unprivileged ports, including
HMR, exact origins, duplicate binding and shutdown. Browser tests import the packed
components with synthetic transcripts, checking both lanes, scroll following,
disclosures, reconnects and narrow windows. They write ignored screenshots/traces
under `web/test-results/`. No test uses credentials, microphones or model turns.
