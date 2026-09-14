# 0066: Restore bounded same-thread voice context

Accepted 2026-09-14 at the operator's request after a client network change
retained the working agent but lost the speech front's conversational agreement.
Supersedes [0017](0017-remove-spoken-history-replay.md)'s ban on automatic voice
context and [0029](0029-desktop-startup-context.md)'s ban on continuity framing.
Also supersedes [0026](0026-persistent-voice-transcripts.md)’s ban on reusing the
private transcript as voice context. Their retired configuration keys remain retired. Qualifies
[0053](0053-retain-workspace-session-across-frontend-detach.md): media is new,
but conversation context should continue. Other ownership and native defaults remain.

## Decision

On each effective realtime v3 start, including redial, renewal, frontend
reattachment and exact-root runtime/server resume, read recent completed speech
from the existing private voice transcript for the verified canonical workspace
and root thread. Supply user and assistant text with their original roles via
stock Codex `initialItems`, followed by a developer boundary instruction: this
is historical context, preserve agreements, wait for new input or new work
results, and do not greet again, repeat answers or execute old requests.

This is text context restoration, not audio playback, input resubmission,
`appendText`, a working-agent turn, or work restart. Native root and descendants
retain their existing lifecycle. No new transcript store, summary model, native
fork, global history search, cross-workspace retrieval or Recent Work snapshot.
Voice append prompts keep their native startup-context slot. Its existing
`includeStartupContext` default and explicit overrides stay unchanged.

Explicit raw `voice.extra.initialItems` owns the slot, including `[]` and `null`
as ways to suppress automatic context. An explicit existingCall transport or non-v3 protocol also bypasses
restoration without changing that protocol. A new root has a different transcript;
missing speech yields no generated items. No legacy native-rollout fallback.

## Bounds and trust

Use the exact deterministic transcript path, verify private owner/mode, regular
file, no links, and matching workspace/root header. Read a maximum 8 MiB tail at
a fixed file-size cut, ignore its partial edge lines, and validate complete event
records. Restore only completed transcript segments, deduplicated by realtime
session/item/role identity. Uncompleted deltas, promoted work references and
control events are never converted into dialogue.

The runtime retains at most 128 validated completed speech items in memory before
forwarding their events across IPC to the controller. Merge those newest items by
native identity with the disk snapshot; this closes the gap when a successor offer
arrives before controller persistence. The buffer is runtime-local, is not another
durable transcript, and is discarded with the runtime.

Keep whole recent messages in chronological order within stock limits of 128
items and 8192 estimated text tokens (ceil UTF-8 bytes/4), including the boundary
instruction. A size/count boundary drops older messages rather than inventing a
summary. If the newest whole utterance alone exceeds the budget, no automatic
items are sent and the bound is reported; partial utterances are not invented. Emit a notice for bounded coverage; read/validation failures emit a
notice and allow the call to proceed without discarding the native thread.
The instruction labels the transcript incomplete and tells the speech front to
consult the retained working agent for missing/current work context. Observed
assistant text does not establish what the human heard or that work completed.

The operator requested continuity, authorizing this same-conversation reuse of
already saved speech. This does not grant unlimited retention, perfect recall,
or replay authority for old actions. Older agreements may leave the bounded
window; durable work and native history remain with their existing owners.

## Evidence and validation

Incident observation: the same root/controller/generation recorded a realtime
close at 18:28:00Z and successor start at 18:28:06Z. The new speech session answered
a bell-convention follow-up generically, although the working root still retained
the agreement. A second client restart showed the same split at 18:34Z. This
establishes the layer boundary, not radio-level causality.

Installed Codex 0.154.0 generated experimental schema confirms role-bearing
`initialItems` on `thread/realtime/start`. Inspected stock source
`112be0bd74` (`core/src/realtime_conversation.rs`,
`codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs`) validates
v3 bounds and encodes them as initial session items. No new response request is
submitted by AgentVoice. The live service can still respond unexpectedly;
framing is model guidance, not a protocol-level silence guarantee.

Fake runtime tests verify lifecycle boundaries, exact-root isolation, role and
raw override preservation, Unicode/count bounds, incomplete records, unsafe
files, and no work/input submission. Live recall, quiet startup, interrupted
utterances and new work-result delivery require an explicitly authorized call
window; a code build alone cannot prove them.
