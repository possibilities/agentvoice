# Web Agent input semantics

The Agent composer is owned with the transcript UI inside AgentVoice. AgentVoice owns its transport and
queue, submitting explicit human text through the existing attachment bootstrap
and gateway. Reading transcripts never submits work. Voice has no composer.

## Native and desktop evidence

Implementation was checked against Codex CLI 0.154.0, the Codex source checkout
at `d6ce3c6a70`, and the installed ChatGPT desktop app 26.901.51231 (build 8109).
The official [app-server contract](https://learn.chatgpt.com/docs/app-server)
defines `turn/start`, `turn/steer` and `turn/interrupt`.

- `codex-rs/app-server/src/request_processors/turn_processor.rs`: start uses
  start-or-steer semantics. There is no native queue RPC. Steering requires the
  exact active `expectedTurnId`; it does not start a new turn or change settings.
- `codex-rs/tui/src/chatwidget/input_flow.rs`, `input_submission.rs`,
  `input_queue.rs`, `input_restore.rs` and `tui/src/app_server_session.rs`:
  separate active turns, pending requests, FIFO follow-ups and interrupt dispatch.
- Desktop `app-initial-cadb12d4a15e.js`: desktop follow-up setting defaults to
  steer; `sendMessage`, `startExecution` and interruption handling keep queued
  input separate and pause it on interrupted completion.
- Desktop `app-primary-6cd7b8b3f5e3.js` and
  `queued-message-list-ad772586ca15.js`: idle Send, busy Steer/Queue, empty-active
  Stop, mode selection and queue row Steer/Edit/Remove affordances.

## Host behavior and boundaries

The browser posts a strict named command with the current view incarnation and a
fresh request UUID. The host binds instance, generation, canonical workspace and
thread before obtaining a short-lived attachment ticket. Immediately before the
one native mutation it checks call and turn identity again. It never sends model,
permissions, cwd or other launch overrides, reads, descendant navigation, or
answers to native prompts. AgentVoice reports native approvals but does not answer them.

The browser always shows Send, disabled when input is empty or submission is
unavailable. The follow-up selector chooses Steer or Queue while Agent works.
A fixed full-width divider above the composer indicates work, with a still
reduced-motion state and no Working label or reserved text padding. No Stop control is shown; the host API retains interrupt support and
its lifecycle below.

Queue draining requires confirmed idle state and dispatches one row at a time.
Rows keep their FIFO position during editing; the shared component awaits a host
hold before restoring text and awaits release after save/cancel. A page lost
during editing leaves a visible held row that can be explicitly resumed.
Stop pauses queued rows before interrupt dispatch. Its acknowledgment does not
mean completion: the authoritative terminal turn event clears stopping. Stop
targets the root Agent turn; it does not end voice media or implement the desktop
app's broader conversation cleanup of goals, descendant turns or background terminals.

A definitive stale steer rejection retains the draft for an explicit Send; it
does not silently fall back to a new turn. This keeps the submitted action tied
to the user's chosen turn. The gateway's native start-or-steer behavior still
applies if another client starts work after the host's final idle check.

Queued rows are saved before dispatch with unknown acceptance, and removed only
after native acknowledgment. Failed writes disable automatic draining. Restart,
call replacement, interruptions and rejected/unknown dispatches require review
before resuming. Unknown acceptance cannot be resumed or steered directly: inspect
native history, then edit or remove deliberately. Submitted input clears immediately so the person can prepare another draft.
A definitive failure restores the submitted text only when the current draft is
empty; otherwise a recovery action preserves both texts. No failure retries
native input automatically.

The server caches 128 request identities in memory; identical HTTP retries reuse
the result, and identity reuse with different text is rejected. This is bounded
HTTP deduplication, not durable native exactly-once delivery. A process crash or
lost response can leave unknown delivery, which the UI reports explicitly.

Tests use fake native WebSockets behind the real attachment gateway and private
control/event fixtures, plus the actual packed shared composer in browser tests.
They start no audio, inference, call service or account flow.

## Optimistic display and reconciliation

Send and Steer add a browser-local Human row before HTTP acknowledgment, marked
Sending or Steering. Queue adds a disabled local queue row immediately, without
claiming native submission. Accepted requests remain marked until observed.
The HTTP request UUID is passed as native `clientUserMessageId`; a queued row
uses that UUID for its first dispatch. Editing gives the next dispatch a fresh
client identity while preserving the queue row and its position, so explicit
recovery from unknown delivery cannot collide with an earlier accepted input. Native `userMessage.clientId` maps
to the same display identity, so authoritative text and order replace the local
placeholder even when text is corrected or two requests have identical bodies.
Unrelated matching text never acknowledges a request.

The native source carries this identity through `turn_processor.rs` into user
turn input and preserves it in `app-server-protocol/src/protocol/thread_history.rs`
(verified in the local Codex source). No native request fields or settings are
invented. Input without a reported client identity retains its native item key.

A rejection removes the local transcript/queue placeholder; unknown delivery
remains visibly unresolved until its exact native identity appears. A native
echo observed before an HTTP failure establishes acceptance and prevents a
spurious draft restoration. View replacement fences all local placeholders and
late replies. Browser refresh restores entry recovery data under its opaque workspace/thread
scope. Pending text is retained for review and reconciled only by exact native
or queue identity; it is never automatically resent. The persisted host queue
and native history remain authoritative. Newer drafts remain independent of
acknowledgments and failed-input recovery. Browser storage is best effort: denied
access, quota, eviction or explicit clearing can prevent recovery.


## Reader recovery

A recoverable observer failure preserves the last verified same-call history and
browser entry scope. Sending is disabled while reconnecting, while drafting stays
available. The reader revalidates exact native session identity before
resuming; verified replacement fences old actions and selects a separate thread
scope. Background history failures do not close the live-read socket. Bounded
diagnostics retain future failure reasons without conversation bodies or secrets.
See [ADR 0058](adr/0058-durable-web-composer-and-reader-recovery.md).

The controller serves the root live view from its own generation-scoped projection
after checking instance, generation, lease, and root identity. It does not consume
a disposable-worker history slot for a result it would discard. Native observation
capacity pressure (`busy`) from an older controller after a verified live read is
a catch-up state, not a transport failure. The reader retains its verified event
socket and input authority, retries the snapshot with backoff, and keeps the
composer available while identifying the transcript as catching up. Socket loss,
controller/session mismatch, an unavailable observer, and browser-to-reader loss
still disable actions. Those states keep the draft editable and show the reason
beside the composer; a dim divider therefore means input is actually fenced, not
merely that one observation request was deferred.

Disabled action buttons do not fade the editable field. In particular, an empty
healthy draft disables Send without making the whole composer look unavailable;
reconnect states keep full-contrast editable text while the fenced actions and
plain-language reason carry their own state.

Voice frontend attachment is independent of text interaction. Send, Steer and
Queue remain available against a reachable, verified retained native session after
media disconnect; media changes alone do not replace the view or pause its queue.
A server with no session yet remains empty and cannot accept scoped input.
See [ADR 0062](adr/0062-web-text-interaction-without-voice-attachment.md).

## Local file references

**Reference a file** opens a bounded picker for visible files in the AgentVoice
reader host's home folder. Selecting a file inserts `@/absolute/path/to/file` into
the draft at the selection. The reference stays fully editable, including its
filename and spaces. Send, Steer, Queue and queued editing send that exact text
through the unchanged native text input contract; choosing a file sends no turn.
Cancel and picker errors leave the draft intact.

Drop or paste absolute path text or local `file://` URIs into the composer for the
same result. If a browser exposes only a filename, use the picker or copy the full
path. Clipboard images without a stable local path cannot be referenced. Files
are never read, uploaded, copied or saved by these controls. A phone browser's
picker selects files on the Agent host, not files on the phone.

The host endpoint `POST /api/files` returns directory metadata only. It requires
the existing loopback peer and exact same-origin JSON guards, does not cache
responses, excludes hidden entries, symlinks and special files, and bounds request,
scan and result sizes. Paths outside the home tree can still be typed directly;
file access remains subject to native Codex permissions. See
[ADR 0078](adr/0078-composer-local-file-references.md).
