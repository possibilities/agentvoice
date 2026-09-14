# 0058: Durable web composer drafts and reader recovery

Accepted 2026-09-14 at the operator's request. Refines
[0057](0057-responsive-web-transcripts.md), separating browser entry recovery from
native delivery and transient transcript transport availability.

## Decision

The transcript reader retains the last verified same-call presentation during
recoverable observation failures. It disables mutation while reconnecting, checks
exact workspace, thread, controller, generation and frontend identity before
resuming, and clears the old call on a verified replacement. Background history
paging uses an independent socket so its timeout cannot tear down live reads.
Bounded diagnostics preserve failure reasons without transcript bodies or secrets.
They use `web/reader-diagnostics.jsonl` below the AgentVoice state directory,
with one rotated file, a 256 KiB limit per file and private filesystem modes.

The shared composer stores browser entry data under an opaque workspace/thread
scope, separate from the random action incarnation. That scope survives a reader
reconnect or page reload, while another thread receives separate drafts. Pending
input and failed-submit recovery remain distinct from the newer main draft; only
exact observed native/queue identities reconcile submissions. Recovery never
replays native input automatically. Queued edits retain both the current edited
text and the draft that preceded editing.

Actions are disabled while disconnected, but text editing remains available.
The full-width divider above the composer carries indeterminate work progress,
with fixed geometry and a still reduced-motion state, replacing the Working text
and its reserved padding. Native browser text shortcuts keep their defaults.

## Consequences

Browser persistence is best effort on this origin and browser profile. Storage
may be unavailable, full, evicted or explicitly cleared; it is not a backup or a
cross-device synchronization service. Only entry recovery data is stored, not
transcripts, credentials or native authority. A failed write must not erase the
in-memory draft or prevent typing. Writes coalesce over 120 ms, with immediate
submission and lifecycle flushes. Abrupt process loss before a write or browser
storage eviction can still lose entry data. Each tab stores a separate record;
a newly created browser session offers existing same-scope text for explicit
recovery. Duplicated tabs that clone session storage can share a record and
therefore retain last-writer behavior. This is local recovery, not concurrent
editing synchronization.

An HTTP acknowledgment and native history are separate observations. Reloaded
pending input requires explicit review until its exact identity is observed; text
similarity is never acceptance. Thread replacement cannot inherit stale action
authority even when browser data is recoverable.

The observed transcript reset occurred while native processes survived. The
original implementation swallowed the triggering error, so its precise cause
could not be attributed retrospectively. Recovery addresses the destructive
consequence and records future evidence without asserting an unproven timeout.
Installation/build preparation does not authorize restarting the active service.
