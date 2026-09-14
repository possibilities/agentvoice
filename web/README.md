# Live Agent | Voice transcripts

`agentvoice serve` opens a live web view at **https://agentvoice.localhost**.
Two equal, full-height lanes put Agent on the left and Voice on the right. They use
`@agentchats/transcript` with Human / Agent labels, Markdown and inline tool/diff
disclosures. There is no toolbar or call control.
The Agent lane includes the shared text composer with an always-visible Send
button and Steer / Queue choices while Agent is working. Send is disabled when
its action is unavailable. The divider above the composer shows work without
changing padding or layout; reduced motion keeps it still. The Voice lane has no
composer. Browser-local entry recovery preserves drafts, failed submissions and
queued edits across reloads for the verified workspace/thread. Storage is best
effort in the same browser profile and origin; unavailable, evicted or cleared
storage can prevent recovery. Recovered input is never automatically resent. The Funk kiosk
supplies a stable single-window persistence identity so reopening it restores the
main draft; ordinary browser tabs retain independent draft slots. A compact
synchronous entry journal protects committed text before the full record is
batched. A newly installed native bridge requires a later kiosk relaunch; old
unidentified browser slots remain explicitly recoverable rather than being
silently adopted from another active context.
A quiet lined dock below Voice tracks the Agent composer's height, keeping the
two transcript viewports aligned as drafts and queued messages expand.
Both lanes window measured message blocks, open at the latest message and follow
new text. Stable row identities retain tool expansion across polls, appends and
group changes. Browser find sees mounted history; the API retains the complete
loaded transcript. A single expanded activity group remains one measured block. Scrolling
up releases follow on the first deliberate upward wheel, touch, or keyboard input,
even within a pixel of the bottom. It lets you read earlier text and shows the shared jump-to-latest chip with a count
of new messages. Using the chip or scrolling back to the bottom resumes following.

The view observes the existing **default local AgentVoice server**, independent of
the launch directory. A missing server shows “No agent voice server to connect to.”
A server with no workspace session yet shows a normal ready/empty state. Once a
session exists, detaching its voice client keeps authoritative Agent/Voice history
available and continuing to update; sending is disabled while the composer stays
editable. Transport unavailability is shown separately, with last verified text
retained until it can be reverified. Actual session replacement clears old session
presentation and action authority. The reader never creates a session or attaches
media. It reconnects its observation automatically.
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

A running development reader retains its optimized dependency graph. Installing a
new transcript archive with `npm ci` and building successfully does not prove that
the named origin serves the new composer. After a dependency upgrade, coordinate
a refresh of the **web reader** and verify the imported browser module and an
isolated persistence fixture. Restarting the kiosk alone cannot replace stale
JavaScript served by Vite. Keep this separate from the default AgentVoice server,
native call, Codex process and kiosk; those are not restarted by web delivery.

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
accepts control protocols 5 and 6 so an existing call need not restart to open this view;
the thread monitor/HUD also accepts these read-only status versions, while
mutation discovery keeps the current protocol requirement. For transcript and action
requests, the browser cannot select a workspace, thread, path, endpoint or RPC method. Native sockets, descriptors,
credentials and grants remain in the local process. Requests require a loopback
peer and exact direct-loopback or named HTTPS origin; foreign hosts/origins are
refused. Remote Markdown images and embeds are blocked.

Local Markdown links open an in-app document viewer with Back and Close. The
shared package owns rendering; `POST /api/document` resolves only linked documents
under host-granted roots. Relative links use a previously served document as their
base. Original links and canonical source paths remain visible. Ordinary external
links keep browser navigation. Unsupported, unavailable or disallowed documents
show an error; there is no arbitrary file browser or remote-page proxy. See
[ADR 0063](../docs/adr/0063-linked-markdown-document-viewer.md) for the access boundary.

The Voice lane incrementally tails the same private, identity-checked JSONL used
by `attach voice`, including saved speech from previous calls on this exact thread.
Draft deltas update stable item IDs; canonical completions replace them. Runtime
and realtime-session IDs fence reused item IDs. Recording gaps remain visible.
Recording reads retain the existing 64 MiB file / 1 MiB record limits. Observed
times describe transcript receipt; they do not prove when speech was heard.

The Agent lane uses event protocol 2: subscribe first, validate `state.get`, then
read `conversation.live.get` and page `conversation.items.list` newest first.
First open shows one loading notice in the app header. Both panes remain hidden until the
initial Agent history pass and the Voice file present at attachment are loaded,
then appear together at the latest messages. Missing/unavailable Voice history
uses its visible notice instead of holding the view indefinitely.
Native history loads continuously in the background, one bounded request at a time, merged by turn
and item ID. Pages accumulate privately until the pass finishes or reaches the
viewer limit, then publish together. The API continues to collect live items while
the header loading state holds the initial view. Both lanes open at the end
without animated scrolling. Initial Agent loading has a five-second budget: a
slow or failed pass publishes the available batch once and reveals the view with
a notice. Retries run in the background after a delay, never reopening the centered
loader. Later refreshes retain the published history
until their replacement is ready. Complete live projection items replace overlapping history; partial
live text cannot overwrite canonical history. Completion, gap and revert events
invalidate history; reverted content is cleared. A reconnect loads a new exact
snapshot, so there is no ambiguous delta replay. Every response and late history
page is fenced to the call and runtime generation. History is bounded to 10,000
items / 8 MiB with a visible notice. Unknown times are omitted. Native reasoning
stays hidden, matching the shared transcript renderer. This view neither reads
Codex databases directly nor resumes threads, answers approvals,
loads launch configuration, starts media or changes server protocols.

Canonical realtime delegation envelopes use the shared Codex presentation helper:
the delegated input appears as “Via Voice”, with an upper-right inspection button
for displayed text, optional Voice context and the exact Original message. Session
endings display as context handoffs. Unknown,
malformed or mixed envelopes retain their ordinary presentation; original content
is never rewritten. Column width, responsive padding and message spacing come
from the shared package, including in the two narrow lanes.
Version 0.3.4 retains the larger monospaced console theme, compact spacing and
composer focus treatment while adding windowing, stable disclosure state and
optimistic submission support. See [ADR 0057](../docs/adr/0057-responsive-web-transcripts.md).

Function, MCP and dynamic tool outputs have readable sections ahead of their
complete Original record. The display mapper unwraps at most two JSON-string
layers per known output envelope, expands only known text/content/output fields
through three levels, and keeps plain or malformed text intact. Nested arbitrary
string properties are not rewritten. Oversized encoded strings and unsafe numeric
values remain in their original representation.

Live snapshots keep composer controls separate from transcript rendering. Unchanged
controls retain their identity, so transcript-only polls do not rerender the input
owner or replace its callbacks. Subsequent transcript rendering is deferred so
keyboard input can take priority; control state remains current, and initial
history reveal and call replacement still update atomically. Draft state stays
inside the shared composer, keyed only by the call view identity.

The Agent composer and matching Voice placeholder sit below the scroll areas,
separated by full-width dividers. Both scrollbars end at those dividers, and the
viewports stay aligned as drafts or queues grow. There is no overlay clearance.
Headers use the transcript’s mono typography and shared reading alignment.
The composer uses the dock canvas directly, with focus on its top divider instead
of a nested input frame. Its thick line is bright when the native runtime is
verified reachable, dim grey when unavailable, and animated only while reachable
and working. Voice-client detachment alone keeps the bright state. Reduced motion
uses a still working indicator; all states occupy the same geometry. Actions retain
a 44px touch row. Multiline drafts and queue content can
expand both docks together; long drafts scroll within the capped text field.

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
Native completion dispatches queued input even when the browser stops polling.
Rows support Steer, Edit and Remove. Editing holds the row until the awaited
save/cancel handshake releases it. This UI omits Stop and always shows Send, disabled when not actionable.
The follow-up selector determines Steer or Queue behavior while running; Working
sits at the upper-right of the composer without moving its controls.
The underlying interrupt API and queued-work pause semantics remain supported.
Resume explicitly releases paused rows.

The host saves at most 20 queued messages (64 KiB each) in private mode-0600
`web/queued-messages.json` under AgentVoice state. Restart or call replacement
restores them paused for review. Failed dispatch stays paused; unknown acceptance
never retries automatically. Check native history before editing/removing a row
whose delivery is unknown. Submitted text appears immediately with a pending status, reconciled by the
native client message identity. Failures preserve recoverable text without
overwriting a newer draft; native history supplies the confirmed message. Request IDs deduplicate a bounded
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

## Presentation preference

The Agent / Voice / Both switch selects the visible panes; Both is the default.
Hidden panes remain mounted and keep their draft, disclosures and reading state
while new history arrives. One responsive app header contains AgentVoice branding,
the current view label, connection status and the square segmented selector. Pane
names remain accessible without duplicate sticky headings. Status has a reserved
line, so connection changes do not move the transcript. In Both mode, the bottom docks share
a three-pixel divider and matching geometry; the Voice line uses translucent lime.
Voice-only hides its alignment placeholder and reclaims the full transcript height.

Text and native controls use the same monospace stack, including portal dialogs.
Voice details open in a square-cornered dialog with an inset inspection control;
the dialog title supplies its accessible name without a redundant visible hint.

Selection is written immediately to browser-local storage, independently of the
call/workspace. A Funk kiosk uses its existing stable instance identity, so the
same kiosk profile/origin restores its choice after exit/reopen. Ordinary browser
tabs share the saved default without forcing another active tab to switch. Invalid
values or blocked reads default to Both; failed writes leave the switch usable
and show “View saved for this visit only.” Cleared, evicted or unavailable storage
cannot guarantee restoration. No native action or voice attachment is triggered.

Steer/Queue already persists with the composer. Runtime status and transient
scroll/follow/disclosure state are not stored as presentation defaults. See
[ADR 0064](../docs/adr/0064-browser-presentation-preferences.md).
