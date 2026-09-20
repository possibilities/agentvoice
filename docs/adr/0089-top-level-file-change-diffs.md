# 0089: Render native file changes as top-level diff cards

Status: Presentation superseded by [ADR 0105](0105-compose-transcript-events-from-primitives.md).

Accepted 2026-09-16. Refines [0057](0057-responsive-web-transcripts.md),
[0075](0075-own-web-transcript-ui.md), and
[0077](0077-bounded-transcript-content-summaries.md).

## Native contract

Stock Codex 0.153.4 exposes one `fileChange` item for an apply-patch operation.
The item carries its native ID, status, and an ordered `changes` array. Each
change has an exact path, an `add`, `delete`, or `update` kind, and either full
file content or a unified diff; an update may also carry `move_path`. The
AgentVoice projection preserves those fields in both live snapshots and native
history pages, keyed by the original turn and item IDs.

`item/started` and `item/completed` represent the in-progress and canonical
states of that same item. The separate `item/fileChange/outputDelta` field is
legacy textual apply output, not a structured file diff, and persisted history
does not contain it. AgentVoice retains it only in the bounded live projection;
the web transcript does not reinterpret it as patch data.

An item larger than the 48 KiB projected-item budget becomes one explicit
`unavailable` item with native type, status, byte count, and bounded excerpt.
The live AgentVoice contract never truncates an individual diff and claims it is
complete. The retained Codex source adapter can report its own `diffTruncated`
flag, which remains source-attributed presentation metadata.

## Decision

Render each native `fileChange` item as one independent transcript row rather
than a child of a collapsed consecutive-activity group. Keep one multi-file card
for one native item, preserve the received file order, and retain the existing
turn/item row key across streaming and canonical replacement. File rows open by
default so the affected paths and add/remove counts are immediately visible;
each potentially expensive diff remains an explicit disclosure and loads Pierre
only when opened. The exact original projected record stays available in a
separate keyboard-accessible details disclosure.

The card uses the transcript's established monochrome marker, typography,
spacing, and status language. It adds no branded shell or decorative surface.
The current Vercel design guidance and the native-fleet adaptation support this
task-first hierarchy: paths and change magnitude lead, transport detail recedes,
and color supplements rather than replaces `+`/`−` text and operation labels.

Create and delete contents are converted locally into valid unified patches for
Pierre. Updates retain their native unified hunks, including rename destinations.
An empty file, path-only rename, or missing diff receives an explicit text label.
If Pierre cannot parse a nonempty patch, the complete source patch appears as
plain text. A source-truncated retained diff says only that the source truncated
it; it does not claim an AgentVoice byte limit. Oversized native items keep the
existing bounded unavailable disclosure as a top-level row and never acquire an
invented partial diff.

## Consequences

Commands and other adjacent tools can still collapse into activity groups on
either side of a file card, but the file operation is rendered exactly once.
The transcript model remains provider-neutral; `nativeItemType: "fileChange"`
identifies unavailable fallbacks, while `fileChanges` carries renderable changes.
No native history, event, file, or workspace content is read or mutated by the
renderer.

Focused projection tests cover create, edit, delete, rename, multi-file order,
streaming/final replacement, original detail, and oversized fallback. Browser
checks cover top-level grouping, default path visibility, keyboard disclosure,
Pierre rendering, source-truncation language, and narrow layout screenshots.
