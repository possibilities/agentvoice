# 0010: Quiet voice reconnects

2026-09-05. Implementation verified with fake protocol tests; live acceptance pending.
This qualifies ADR 0008's baseline without changing its native context settings.

## Problem and evidence

The operator created a new AgentVoice thread, asked for four filenames in its
workspace, heard the completed answer, quit, and resumed. The next voice call
spoke the same answer without a new request. Native rollout and startup-context
logs establish that the correct thread resumed, its working answer and voice
transcript were persisted before quit, and the second call contained no new
user message or working-agent turn. Its generated startup context included the
previous directory request and answer. AgentVoice sent no replay or appendText.
This is distinct from the earlier thread-list source/ownership selection bug.

In stock Codex 0.153.3:

- [Realtime startup](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/realtime_conversation.rs)
  adds generated context to the voice instructions, with no automatic restoration
  of a prior voice call's initial items.
- [Startup context](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/realtime_context.rs)
  uses a bounded snapshot of working-thread user/assistant messages. The saved
  realtime transcripts are not inputs to its Current Thread section. It tells
  the model not to repeat background unless relevant, but contains no explicit
  wait-for-new-input requirement.
- [V3 call configuration](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs)
  accepts developer initial items. The app-server surface inspected here exposes
  no V3 startup-silence switch. V2 response-create/VAD controls are not evidence
  of such a switch on this transport. The exact service-side generation trigger
  is not established by the local logs/source.

The installed desktop bundle was inspected read-only: Codex desktop 26.831.20005,
build 7524, bundled CLI/app-server 0.152.0. Its
`webview/assets/app-initial-592a0643ed17.js` (SHA-256
`aefea66d253e84287721d5c3aa80ada744fad33033d4b1c5c4c11d3f30eaa29c`)
contains a continuity prompt starting with "You are resuming an existing voice
chat after a pause" and instructing "Remain completely silent when this session
starts" until a new user message arrives. It also contains optional client
transcript recording/reinjection and memory-summary machinery. Runtime rollout
flags were not inspected, so this proves an implemented path, not universal
desktop behavior. Desktop continuity cannot be inferred from stock app-server
defaults alone.

## Decision

On continue, explicit resume, and reconnects after a successfully started voice
call, add one developer `initialItems` entry asking the voice to wait for new
input rather than greet or repeat old context. Allow new results from work still
running to be delivered. Apply only to effective WebRTC v3. A fresh conversation's
first call is unchanged. A stale started notification cannot enable the policy;
Fresh resets the voice-call boundary.

This is an AgentVoice product policy implemented through a native input, not a
native default. `voice.quiet-resume` defaults on and accepts false to opt out.
Explicit initial items, including prompt-file seeds and raw empty arrays/null,
replace the default. The native base voice prompt stays omitted, context controls
stay unset, and explicit protocol choices are preserved. Nothing reads/copies
transcripts, writes history, or submits a working-agent turn for this policy.

Turning off startup context would sacrifice immediate recall without proving
quiet startup. Output muting would hide generated speech rather than correct
turn-taking. Enabling tail flush can start work at hangup and does not guarantee
preservation across a hard kill. None is part of this change.

## Limits and acceptance

This instruction depends on model compliance; protocol tests cannot prove it
will remain silent. Native history still omits some voice-only exchanges from
the next call's snapshot. The requested directory answer is in working-thread
history, so this fix is applicable to that report. Complete voice-only recall
needs a separate decision about native support or client continuity handling.
Do not present this as restoring the same realtime session or exact hidden state.

The operator's live test is: create fresh, request filenames, hear the completed
answer, exit, resume the same workspace, remain quiet, then ask "what was the
last file name again?" Expect no unsolicited listing and a correct follow-up.
Repeat after killing the process once the answer has been durably saved, and
after redial. Uncommitted audio at a hard kill cannot be guaranteed to persist.
Also check normal new requests and new results from work active during redial.
No inference, microphone capture or playback was used to validate this change.
