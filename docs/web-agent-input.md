# Web Agent input semantics

The Agent composer is shared with agentchats. AgentVoice owns its transport and
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
permissions, cwd or other launch overrides. Native approvals remain stock TUI-owned.

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
native history, then edit or remove deliberately. Direct input stays in the shared
composer on request failure. No failure retries native input automatically.

The server caches 128 request identities in memory; identical HTTP retries reuse
the result, and identity reuse with different text is rejected. This is bounded
HTTP deduplication, not durable native exactly-once delivery. A process crash or
lost response can leave unknown delivery, which the UI reports explicitly.

Tests use fake native WebSockets behind the real attachment gateway and private
control/event fixtures, plus the actual packed shared composer in browser tests.
They start no audio, inference, call service or account flow.
