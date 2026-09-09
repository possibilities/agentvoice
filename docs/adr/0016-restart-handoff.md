# 0016: Submit an optional handoff after runtime restart

Accepted 2026-09-05. Extends [ADR 0015](0015-retain-controller-replace-runtime.md)'s runtime restart with a caller-supplied
task for the resumed backing agent. The retained foreground topology, exact
thread lease, native prompt defaults, and ordinary reconnect behavior remain.

The restart request accepts one optional bounded `handoffPrompt`. Acceptance
privately journals the payload and selected workspace/thread together with the
operation before teardown. Payload equality participates in immutable request
identity. Control protocol 2 introduces this request field; Unix clients must
send version 2 and a full foreground relaunch activates the new controller.

After the same conversation is resumed and media is live and enabled, the
controller requests one native `turn/start` through the replacement runtime.
Input is labeled as a restart handoff, not fabricated user speech or developer
policy. Native start-or-steer behavior supports an idle backing agent and a
regular turn that began during reconnection. Native output can reach voice
without an earlier voice delegation, but actual speech remains a live test.

The operation exposes a distinct handoff status and native turn/correlation IDs.
An RPC failure must not run the restart teardown handler or turn healthy media
into failed media. A native refusal is a failed handoff; a lost or malformed
reply leaves acceptance unknown. Each operation permits one submission attempt,
with no automatic retry or replay after another readiness event or restart.
Correlation IDs do not establish exactly-once execution. The private journal
holds prompt text; public status and error messages omit it. Native history
receives the submitted task normally.

This first mechanism intentionally needs no separate mailbox CRUD, queue,
expiry, cross-controller recovery, or persistent prompt changes. The controller
already survives the required runtime replacement. Developer instructions add
context but do not wake the backing agent; the native queue adds independent
auto-start and pause semantics. Both remain available for future requirements.
Redial does not accept this prompt. A full quit does not recover old handoffs.

Validation separates stored payload, native acceptance, executed work, and
audible response. Fake protocol/media tests establish ordering, exact identity,
deduplication, and failure handling. Only a live trial can establish that the
waking agent acts and the user hears it.
