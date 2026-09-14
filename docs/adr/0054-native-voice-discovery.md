# 0054: Discover native voices and persist one random choice

Accepted September 13, 2026 for dedicated voice inspection and typed random-different
selection. Extends [0042](0042-workspace-role-databases.md); supersedes its reliance
on startup-only native voice validation for controller-managed named edits. Offline
CLI saving and full role snapshots retain their existing ownership.

The shared control/API/MCP surface gains `voice_get`, returning native compatible
choices, current requested selection, pending saved state, editability and mutation
fences. `voice_set` remains the durable mutation, accepting an explicit voice/null
or an exclusive random-different selector. Generic settings editors can reuse these
primitives; consumers need not scrape config-schema descriptions to choose a voice.

The owned Codex child supplies `thread/realtime/listVoices`. The inspected native
implementation and installed 0.154.0 experimental schema expose v1/v2 families and
defaults; native v3 uses the v1 family, while WebRTC rejects v2. Cache successful
catalog reads per runtime, allow explicit refresh, and report unavailable/malformed
catalogs without static or public API substitution. This is runtime-declared
compatibility, not account eligibility or a promise that audio succeeds. The
controller instance, generation, native PID and fetch time identify provenance.

Named API edits validate compatible membership before saving. Immediate edits use
the loaded protocol; deferred edits use the desired role protocol. Raw voice masking
still rejects managed editing. Null preserves native resolution and can clear a
selection when discovery is unavailable. Ordinary call startup is not gated by the
new discovery RPC. Settings remain strings for portable, forward-compatible roles.

Native started notifications identify a session and version but omit resolved voice.
Track the matching explicit start request and require live client media before
reporting its name. Keep the native fallback separate from current voice. Omitted
voice stays unknown to the caller even when its possible fallback is listed.
Unconfirmed application after dispatch has an unknown result; a later save-only
operation must not erase that uncertainty. A confirmed voice apply or new runtime
generation resolves it. No audible timbre verification is claimed.

Random-different excludes the known current requested voice, not a pending saved
selection. Unknown current voice or no compatible alternative rejects before save.
Choose under the existing controller mutation fence and save the resolved name,
original selector and catalog provenance in the SQLite receipt. Retry reuses that
choice, including recovery when save succeeded but controller journaling failed.
Randomness is an operation, not a role setting rerun at startup.

Control protocol 7 carries the schema extension. Loaded controllers retain their
old code/catalog until an explicitly authorized server restart; command publication,
voice redial and replacement of the disposable runtime do not reload the controller.
This change does not restart a call, adopt prompt settings, or add voice-history replay.

Verification uses native-catalog fixtures, fake media and owned fake Codex processes:
compatibility groups, invalid inputs, stale fences, native errors, request identity,
unknown/current state, save/application separation and retry recovery. Live audio
availability remains unverified by these checks.
