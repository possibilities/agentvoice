# 0074: Keep historical speech outside realtime input

Accepted 2026-09-15. Supersedes [0066](0066-same-thread-voice-continuity.md).

## Problem and decision

Two preserved incidents showed completed historical requests becoming fresh root
work after a new realtime connection. Frontend identity is not established; this
is a client-independent server boundary. ADR 0066 placed old user/assistant
speech in native `initialItems`. Its trailing developer warning could influence
the hosted model, but could not prevent native delegation of an old request.

Remove automatic transcript reads, the runtime completion buffer and generated
initial items on every start: renewal, redial, frontend reattachment and exact-root
runtime/server resume. A quoted developer transcript would still expose old
commands to an agent capable of delegation; it is not an enforceable fix.
Fail closed by keeping saved speech entirely outside automatic realtime input.
There is no text-hash denylist: a fresh command can legitimately repeat old words.

Useful context remains in its existing non-actionable representation: private
voice transcript observations and the read-only Voice lane. Any context already
present in native root history remains; native delegation does not necessarily
copy every observed utterance into that history. No file is erased or rewritten. The working agent can consult prior
agreements in response to fresh input. Automatic speech-front recall is deliberately
unavailable pending a native admission contract. Explicit operator prompt/context
overrides still pass through; they are not generated transcript restoration and
can request behavior beyond this default policy.

## Native boundary and follow-on contract

AgentVoice chooses a fresh `realtimeSessionId` for each start. Observed speech
retains native session/item identity. These are observation fields, not an
admission token for the stock native voice-to-working-agent handoff. AgentVoice
must not pretend filtering notifications after submission prevents work.

Before restoring automatic historical context, the native delegation owner must
accept and enforce exact root + realtime session + source transcript item IDs,
with an explicit history/current-input distinction. Admission must reject
historical or superseded-session sources, deduplicate a request before turn
submission, retain handled identity across the relevant reconnect/restart lifetime,
and leave ambiguous acceptance unresolved instead of retrying. Legitimate repeated
text with a distinct current source identity must remain eligible. A missing or
unverifiable identity must fail closed. Prompt instructions, timestamp guesses,
and text hashes cannot substitute for that protocol.

That native extension is separable work. This change closes the known automatic
historical-input path now; it does not claim a universal exactly-once guarantee
for hosted native delegation or silence under arbitrary explicit prompt overrides.

## Verification and rollout

Incident-shaped fake-runtime regressions cover Ledger prior completion and the
Nevermind / Sounds good cancellation sequence across renewal, detach/reattach and
runtime replacement. Each successor has fresh session identity, zero generated
initial items and no AgentVoice turn/appendText submission. Saved transcript bytes
remain intact; one fresh successor-session observation with repeated words reaches
the observer once. This proves AgentVoice's request/observation boundary, not hosted
model speech or native handoff delivery semantics.

Run the test suite, typecheck and lint. Publish the command/build preparation without
restarting the live service. The loaded runtime remains old until the human's
explicit restart. In an authorized call window, complete a harmless command, detach
and reconnect while silent, verify no old handoff/turn appears, then speak one fresh
command and verify exactly one native receiving turn with current source evidence.
Repeat the cancellation sequence and an exact-root runtime restart. Do not infer
success merely from an unchanged frontend or a passing build.
