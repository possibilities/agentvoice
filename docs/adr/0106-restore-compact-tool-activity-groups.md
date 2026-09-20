# 0106: Restore compact tool activity groups

Accepted 2026-09-20 at the operator's request. Refines the consecutive-tool
presentation in [0105](0105-compose-transcript-events-from-primitives.md) without
reintroducing the bespoke event cards retired there.

## Decision

Collapse a consecutive run of two or more eligible tool activities into one
compact, closed-by-default disclosure. Its header reports the total activity
count, activity-kind counts, failures, running work, and affected-file count.
Human and Agent messages end a run. Explicit system evidence such as compaction,
recovery, status, and unknown typed system events remains a standalone generic
Tool call. Ordinary tools, file-change tools, and the historical routing-context
rollup retain the activity eligibility they had before their former custom cards.
Subagent lifecycle projections remain filtered from the web transcript.

Expanding the group renders the current generic Tool call blocks in their exact
order with their complete existing disclosures, file attachments, diffs, and
routing details. The group owns one measured transcript row so live append and
settlement keep the first activity's stable identity. Disclosure choices live
above windowing so unmounting, polling, and tail growth preserve group and child
state. Keyboard activation, focus, scroll anchoring, and virtual measurement use
the existing transcript primitives.

The compact header and expanded list use spacing, type, counts, and the disclosure
chevron to communicate grouping. Neither state draws a horizontal divider,
underline, or bottom rule; expanded generic Tool call markers suppress their usual
bottom border only while inside the group.

## Boundaries and verification

This changes presentation grouping only. It does not change event DTOs, ordering,
history, lifecycle delivery, tool details, file or routing evidence, or the three
Human/Agent/generic Tool call presentation types. Focused unit and browser checks
cover eligibility and boundaries, summaries, keyboard collapse/expand, absent
rules, current child details, live tail growth, disclosure retention, responsive
layout, windowing, measurement, focus, and scroll stability.

Source delivery does not authorize installation or a live-service restart.
