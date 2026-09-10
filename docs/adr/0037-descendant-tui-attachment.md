# 0037: Native descendant navigation through TUI attachment

Identifier corrected 2026-09-08: formerly `0024-descendant-tui-attachment.md`. The old number
was shared by another decision; this record retains its original rationale.
See the [identifier history](README.md#identifier-history).

Accepted 2026-09-06: extend [ADR 0022](0022-websocket-native-tui.md)'s selected-thread whitelist to the granted
orchestrator's native descendants in the same workspace, because stock Codex
0.153.4 uses loaded-thread discovery, metadata reads and resume/history paging
to implement subagent navigation.

The runtime's owned connection verifies `parentThreadId` ancestry before the
gateway forwards a descendant request, list row, notification or human question;
positive admissions are grant-local and bounded (32 ancestry reads, 512 admitted
threads, four concurrent checks, six seconds per check/inventory and two seconds
per native read), while unavailable or invalid ancestry fails closed and native
Codex retains direct-input restrictions and approval ownership.

The root remains the revocation identity across subagent navigation: Fresh,
restart, native loss and quit revoke the entire grant, unrelated threads and
forks receive no access, resume strips local setting overrides for every admitted
thread, and explicit speech remains root-only.
