# 0105: Compose transcript events from conversation primitives

Accepted 2026-09-20 at the operator's request. Supersedes the bespoke web-card
presentation in [0085](0085-system-event-transcript-cards.md),
[0088](0088-subagent-lifecycle-transcript-cards.md), and
[0089](0089-top-level-file-change-diffs.md), while preserving their source-data
and identity boundaries where those events remain present.

## Decision

The Agent transcript has exactly three top-level presentation types: Human,
Agent, and generic Tool call. Typed and voice-originated Human messages retain the
same existing secondary bubble/card chrome. Agent prose stays organic and ghost.
Every useful machine event uses the existing Marker-based Tool call disclosure,
including ordinary tools, historical routing, file changes, compaction, recovery,
status, and unknown system evidence. Specialized data such as file attachments and
lazy Pierre diffs may render inside that disclosure; no event receives a bespoke
top-level shell or special compaction treatment.

Human, Agent, and Tool call bodies use the full width available inside the existing
transcript column. The outer column and responsive page gutters remain the only
reading-width boundary; code, tables, diffs, and long tokens retain their bounded
overflow and wrapping behavior.

Remove the system-card registry, routing card, file-change card, consecutive
activity-group shell, their event-specific CSS, and their presentation tests.
Routing rollup identity and effective-context calculation remain, but the result
is adapted directly into the generic Tool call disclosure. Consecutive tools stay
as individually measured disclosures in native order. File attachments live only
inside that same shell. The local Attachment primitive follows the installed
shadcn composition and existing Base UI/Button stack, without adding a dependency.

Subagent lifecycle rows receive no replacement presentation. Human bubble chrome
is outside this custom-event-card retirement. A separate backend
change removes start/stop injection; this UI filters any matching projected rows
instead of establishing a second lifecycle contract. Direct worker result delivery
is unchanged and remains owned by its native completion boundary.

## Preserved behavior

Native event DTOs, status, ordering, stable message IDs, complete Tool call sections,
original evidence, file paths, diffs, source-truncation language, routing revisions,
and keyboard-accessible disclosures remain. Context compaction keeps one stable
generic Tool call row across working and complete states. A voice-originated row remains an ordinary
Human message with a microphone details trigger; internal `Via Voice` provenance
does not render as a second source label. The stable optimistic-row and
keyboard composer contracts in [0102](0102-agent-only-web-transcript.md), including
transcript typing handoff, reading-key navigation, and safe focus restoration, are
unchanged.

The renderer does not read workspace files or change server event, history, voice,
queue, completion, or control contracts. Source delivery does not authorize an
installation or live-service restart.
