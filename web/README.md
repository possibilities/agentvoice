# Live Agent transcript

`agentvoice serve` opens a live web view at **https://agentvoice.localhost**.
One full-height Agent transcript uses the AgentVoice-owned UI with Human / Agent
labels, Markdown and inline tool/diff disclosures. There is no page header, toolbar,
pane selector, raw Voice lane, or call control. Native voice handoffs remain readable
as ordinary Human messages. A compact microphone button immediately beside `Human`
opens the complete details without a tooltip or duplicate visible source label.
Voice-originated and typed Human rows retain the same existing secondary bubble
chrome; only the bespoke synthetic-event card layer is retired.
Human, Agent, and generic Tool call bodies fill the available transcript column;
the established outer column and responsive page gutters remain in place.
The composer has no visible Send button or follow-up selector: Enter sends while idle,
Enter steers while Agent is working, and Shift+Enter inserts a new line. Clipboard images become
numbered removable local-image attachments (four per message, 10 MiB each); ordinary
path paste/drop remains editable `@path` text. Image-only input works. The
local save endpoint retains private files in workspace/thread-owned storage, while
native input carries paths only. See [image and file input](../docs/web-agent-input.md#clipboard-images)
for storage lifecycle and failure behavior. Submission is ignored while its action
is unavailable and the draft remains editable. The divider above the composer shows work without
changing padding or layout; reduced motion keeps it still. Browser-local entry recovery
preserves drafts and failed submissions across reloads for the verified workspace/thread. Storage is best
effort in the same browser profile and origin; unavailable, evicted or cleared
storage can prevent recovery. Recovered input is never automatically resent. The Funk kiosk
supplies a stable single-window persistence identity so reopening it restores the
main draft; ordinary browser tabs retain independent draft slots. A compact
synchronous entry journal protects committed text before the full record is
batched. A newly installed native bridge requires a later kiosk relaunch; old
unidentified browser slots remain explicitly recoverable rather than being
silently adopted from another active context.
A single dock keeps the full-width textarea stable as drafts and queued messages expand.
Printable typing on noninteractive transcript space appends at the end of the current
draft and hands focus to the textarea. With the textarea focused, plain Page Up,
Page Down, Home, and End move the transcript while keeping the draft and focus in
place; modified shortcuts and IME composition keep their native behavior. Safe
pointer completion of transient queue, attachment, disclosure, and viewer actions
returns focus and the caret to the draft end without interrupting active controls,
selection, dialogs, or document reading.
Existing host-owned queue rows remain readable and removable, but this UI cannot
create, edit, resume, or steer queued rows. Empty sessions use one readable heading at the center of the transcript area,
without secondary guidance or notices. Populated transcripts retain their status
notices tied to observed text. Recording boundaries before any speech do not
create a notice that can outlive the empty state. The mounted transcript and composer stay stable when the first message
arrives, preserving drafts, focus and reading state.

The Agent transcript windows measured message blocks, opens at the latest message and follows
new text. Stable row identities retain tool expansion across polls, appends and
disclosure changes. Browser find sees mounted history; the API retains the complete
loaded transcript. Each tool disclosure remains its own measured row.
With an overflowing transcript, the first deliberate upward wheel, touch or
keyboard input releases follow, even within a pixel of the bottom. It lets you
read earlier text and shows the shared jump-to-latest chip with a count of new
messages. Using the chip or scrolling back to the bottom resumes following.
Fully visible conversations keep following and do not show a jump control.
Virtual rows include the existing responsive top inset, keeping the first
message clear of the viewport edge.

By default the view observes the existing **default local AgentVoice server**, independent of
the launch directory. `serve --workspace <dir> --name agentvoice-test` instead pins
the reader to that explicit server at `https://agentvoice-test.localhost`; a missing
selected socket never falls back to the default server. See the
[parallel production/test workflow](../docs/parallel-test-environment.md). A missing server shows “No agent voice server to connect to.”
A server whose selected workspace has no marker or session yet shows a normal
ready/empty state. A valid marker is restored at server startup, so authoritative
Agent history is available before any voice client attaches. Detaching that
client keeps the history available and continuing to update; submission is fenced
while the composer stays editable. Transport unavailability is shown separately,
with last verified text retained until it can be reverified. Actual session
replacement clears old session presentation and action authority. The reader
never creates a session or attaches media. It reconnects its observation automatically.
Closing the page or `serve` leaves the call running.

## Prepare and run

Requires Bun, Node.js 24+, npm, and the shared loopback portless HTTPS proxy.
From this checkout, prepare dependencies once (or after changing lockfiles):

```sh
bun install --frozen-lockfile
npm --prefix web ci
agentvoice serve                 # editable Vite dev + HMR
agentvoice serve --tailscale     # local URL plus a tailnet-only Portless URL
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

`--tailscale` keeps the local URL and adds a root-mounted HTTPS URL on this
machine's Tailscale DNS name. Use `portless list` to find the current app-to-port
mapping; additional apps use ports such as 8443 and 8444. The browser device must
be on the same tailnet. The reader accepts only Portless's exact injected origin,
and Funnel, ngrok, LAN and wildcard routing remain disabled.

```sh
bun run web:dev                  # direct loopback development
bun run web:build
agentvoice serve --production    # Vite preview of prepared web/dist
```

Production remains optional. Both Vite modes use the same API bridge. The named
route is fixed across worktrees. Backend listeners bind strictly to `127.0.0.1`
at portless's assigned `PORT`; HMR follows either admitted HTTPS origin. LAN,
public tunnels and wildcard routes are disabled. TERM, INT and HUP stop the
foreground process tree and unregister its route. A static hosted build cannot
connect to local sockets.

## Connection and transcript contract

`GET /api/live` returns the two host-owned message arrays and a browser-only view
ID. Browsers serialize reads about once per second. One shared adapter deduplicates
concurrent reads, observes the private frontend and discovers the exact live
workspace/thread controller through its verified status. Read-only discovery also
accepts control protocols 5 and 6 so an existing call need not restart to open this view;
the thread monitor/HUD also accepts these read-only status versions, while
mutation discovery keeps the current protocol requirement. For transcript and action
requests, the browser cannot select a workspace, thread, endpoint or RPC method.
The composer accepts absolute-path paste/drop as ordinary editable `@path` text;
the page has no file-picker UI. Native sockets, descriptors,
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

The server continues to tail the private, identity-checked voice recording,
including saved speech from previous calls on this exact thread, but the web page
does not render those raw rows.
Draft deltas update stable item IDs; canonical completions replace them. Runtime
and realtime-session IDs fence reused item IDs. Recording gaps remain visible.
Recording reads retain the existing 64 MiB file / 1 MiB record limits. Observed
times describe transcript receipt; they do not prove when speech was heard.

The Agent transcript uses event protocol 3: subscribe first, validate `state.get`, then
read `conversation.live.get` and page `conversation.items.list` newest first.
First open shows one loading notice inside the transcript surface. The Agent lane
reveals when its own initial history pass is ready and never waits for raw Voice history.
Native history loads continuously in the background, one bounded request at a time, merged by turn
and item ID. Pages accumulate privately until the pass finishes or reaches the
viewer limit, then publish together. The API continues to collect live items while
the loading state holds the initial Agent view. It opens at the end without
animated scrolling. Initial Agent loading has a five-second budget: a
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
the delegated input appears as an ordinary Human message, with a microphone details
button in the right action rail for displayed text, optional Voice context and
the exact Original message. Accessible identity glyphs replace visible author
headers, while semantic timestamps remain associated with each identity mark
([ADR 0107](../docs/adr/0107-transcript-identity-rails.md)). Session
endings display as context handoffs. Unknown,
malformed or mixed envelopes retain their ordinary presentation; original content
is never rewritten. Column width, responsive padding and message spacing come
from the shared package, including at narrow widths.
Version 0.3.4 retains the larger monospaced console theme, compact spacing and
composer focus treatment while adding windowing, stable disclosure state and
optimistic submission support. See [ADR 0057](../docs/adr/0057-responsive-web-transcripts.md).

Function, MCP and dynamic tool outputs have readable sections ahead of their
complete Original record. The display mapper unwraps at most two JSON-string
layers per known output envelope, expands only known text/content/output fields
through three levels, and keeps plain or malformed text intact. Nested arbitrary
string properties are not rewritten. Oversized encoded strings and unsafe numeric
values remain in their original representation.

Native file-change items render in the same generic Tool call disclosure as every
other machine event. Its inner file attachments preserve the received multi-file
order and streaming/final status, show paths and add/remove counts when disclosed,
and lazy-load Pierre only for an opened file diff. Create, edit, delete and rename
use the native change kind and optional destination path. Empty/path-only changes,
source-truncated diffs, parse failures and oversized unavailable items remain
explicit, with the exact projected record available behind Details. The renderer
never reads or changes the workspace. See
[ADR 0105](../docs/adr/0105-compose-transcript-events-from-primitives.md).

Live snapshots keep composer controls separate from transcript rendering. Unchanged
controls retain their identity, so transcript-only polls do not rerender the input
owner or replace its callbacks. Subsequent transcript rendering is deferred so
keyboard input can take priority; control state remains current, and initial
history reveal and call replacement still update atomically. Draft state stays
inside the shared composer, keyed only by the call view identity.

The Agent composer sits below the scroll area, separated by a full-width divider.
The scrollbar ends at that divider. There is no overlay clearance or reserved
header space.
The composer uses the dock canvas directly, with focus on its top divider instead
of a nested input frame. Its thick line is bright when the native runtime is
verified reachable, dim grey when unavailable, and animated only while reachable
and working. Voice-client detachment alone keeps the bright state. Reduced motion
uses a still working indicator; all states occupy the same geometry. Multiline
drafts and queue content can expand the dock; long drafts scroll within the capped text field.
Transient native observation capacity pressure keeps the last verified event
transport and composer authority, labels the transcript as catching up, and retries
without dimming the divider. Actual reader, observer, controller, or browser
transport loss fences submission and names the reason beside the still-editable draft.
An empty draft simply ignores Enter. Reconnect fencing dims the divider while
editable text retains full contrast.

## Agent input

`POST /api/agent` accepts only named composer actions, a current view ID and a
unique request ID. The host discovers the exact live controller and acquires an
identity-fenced host gateway ticket. It sends native
`turn/start`, `turn/steer` with `expectedTurnId`, or `turn/interrupt` with the active
turn ID. It does not override native settings, read native history through this
gateway, navigate descendants, or answer approval requests. Mutation bodies require same-origin JSON and bounded
text. No native endpoint, token, method selector or thread selector reaches the browser.

Enter submits idle input immediately and steers the current turn while Agent works;
Shift+Enter inserts a line break. The page has no Send button, mode menu, Stop
control, or queue-creation affordance. Existing queued rows from compatible clients
remain visible with their server state and can be removed. The underlying interrupt,
queue, editing, resume, and file-list APIs remain supported for compatible clients.

The host saves at most 20 queued messages (64 KiB each) in private mode-0600
`web/queued-messages.json` under AgentVoice state for the default endpoint.
Explicit workspace readers instead use
`web/queues/<canonical-workspace-sha256>/queued-messages.json`; the reader's origin
name does not select queue identity. They never read or overwrite the default
queue or another workspace's queue. Restart or call replacement
restores them paused for review. Failed dispatch stays paused; unknown acceptance
never retries automatically. Check native history before editing/removing a row
whose delivery is unknown. Submitted text appears immediately with a pending status, reconciled by the
native client message identity. Failures preserve recoverable text without
overwriting a newer draft; native history supplies the confirmed message. Request IDs deduplicate a bounded
in-process window; they are not a durable native exactly-once guarantee.

See [Agent input semantics](../docs/web-agent-input.md) for source evidence and
turn/queue boundaries.

## Owned transcript UI

`src/transcript-ui/` owns the provider-neutral data helpers, Codex presentation
adapters, React components, types, utilities and styles used by this app. It was
transferred from the MIT-licensed AgentChats transcript package at `4778b88`
(0.3.13); its license and provenance stay beside the source. There is no archive,
package dependency, adjacent checkout import or runtime dependency on AgentChats.

Readable Tailwind/theme/presentation sources compile into the checked-in scoped
stylesheet with `npm run transcript:styles`. The normal build runs
`transcript:styles:check`, so generated CSS cannot drift from its AgentVoice-owned
sources. The scoped output keeps host styles outside transcript roots unchanged.

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
HMR, exact origins, duplicate binding and shutdown. Browser tests exercise the owned
components directly and through the app with synthetic transcripts, checking the Agent lane, scroll following,
disclosures, reconnects and narrow windows. They write ignored screenshots/traces
under `web/test-results/`. No test uses credentials, microphones or model turns.

## Presentation

The page begins directly with the single Agent transcript and composer. Loading,
offline, and reconnect state appears only when necessary inside that surface.
Legacy Agent/Voice/Both preference bytes are ignored; the app performs no pane
preference reads or writes.

Text and native controls use the same monospace stack, including portal dialogs.
Voice details open in a square-cornered dialog with an inset inspection control;
the dialog title supplies its accessible name without a redundant visible hint.

Runtime status and transient scroll/follow/disclosure state are not stored as
presentation defaults. See [ADR 0102](../docs/adr/0102-agent-only-web-transcript.md).
