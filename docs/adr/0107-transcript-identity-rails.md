# 0107: Put transcript identity beside the content

Accepted 2026-09-20 as the operator's identity-rail experiment. Refines
[0102](0102-agent-only-web-transcript.md)'s visible author header and microphone
placement, [0105](0105-compose-transcript-events-from-primitives.md)'s shared
presentation, and [0106](0106-restore-compact-tool-activity-groups.md)'s group
geometry. Their source and interaction boundaries remain in force.

## Decision

Human, Agent, generic Tool, and activity-group rows share a fixed left identity
rail, full available middle content, and right action rail. Bot, person, speaking
person, and terminal glyphs identify Agent, typed Human, Human via Voice, and
Tool activity respectively. Accessible names carry those identities without a
visible role caption or header row. Known valid timestamps remain semantic time
metadata associated with the identity mark and available through its native title;
voice inspection also includes the message time. Absent or invalid time is omitted.

Human messages retain their existing field surface, two-pixel left rule, and
padding; Agent prose retains its ghost treatment. The voice microphone inspection
button sits in the right rail and retains the complete original evidence dialog.
An empty right rail preserves consistent reading edges across row types. Delivery
state stays visible within the Human surface, after its body, and wraps when long.

Desktop rails are 24 and 28 pixels with 12-pixel gaps. Containers at most 640
pixels wide use 20 and 44 pixels with eight-pixel gaps. Coarse pointers always get
a 44-pixel action target. The outer reading column, page gutters, text sizes and
top-level spacing remain. Expanded activity children align with the parent grid
and use eight-pixel spacing. Group counts, kind summaries, failures, running work,
and file-change counts retain their existing content and responsive behavior.
Tool and group rows have no horizontal divider or underline. Standalone system
Tools remain standalone, and lifecycle rows remain filtered.

Amended 2026-09-20: all top-level identities use a 16-pixel column and an
eight-pixel text gap, with a shared 16-pixel row inset. Human/Voice chrome wraps
the entire identity row, including its glyph and voice action; the two-pixel rule
replaces two pixels of that inset so content stays aligned with Agent and Tool
rows. The voice action retains 28/44-pixel desktop/narrow-or-coarse targets inside
the Human surface. The group disclosure chevron trails its summary so the count
shares the same text start.

Further live-feedback refinement: the shared identity-to-content gap is ten pixels;
the independent right-action clearance stays eight pixels. A desktop/mobile
comparison of ten and twelve pixels chose the smaller relaxation. Agent uses
BotMessageSquare, typed Human uses CircleUserRound, Human via Voice uses AudioLines,
and Tool/group retains TerminalSquare. Their similarly proportioned glyphs share
a sixteen-pixel box and stroke weight, with occupied bounds of twelve to thirteen
and one-third pixels and centered placement. An alternative subtle square-cell
treatment introduced extra boundaries and smaller internal marks; identities stay
unboxed. Accessible names and the existing row surfaces remain unchanged.

Ordered lists also place their decimal marker column at the ordinary prose edge,
with a hanging text inset sized for the largest marker. Native ordered-list/start
semantics remain. Unordered-list marker, padding, spacing and wrapping rules stay
unchanged.

An ActivityGroup owns the only Tool identity glyph for its
expanded list. Its tool, file-change, and routing children render directly in the
group's middle content column, without identity or action rails of their own.
Their disclosure content, state, keys and eight-pixel rhythm remain; standalone
Tools retain the full identity row. Known child timestamps are associated with
the child disclosure trigger when its identity mark is absent.
A routing rollup carries the first source message's `createdAt`, matching its
stable first-source ID. Later updates retain that creation time. Missing or invalid
first-source time stays omitted, including when a later update has a known time.

Scope revision 10 replaces the ten-pixel reading gap with the measured Human/Voice
outer-card-to-icon inset: sixteen pixels, including the two-pixel rule and
fourteen-pixel padding. The row inset and reading gap share one CSS reference so
all identities remain symmetric. The icon cell remains sixteen pixels and the
independent right-action clearance remains eight pixels.

Scope revision 9 refines the expanded group boundary: a closed group has no
divider; an open group has one restrained one-pixel Separator between its header
and children, with no rules between children or after the last child. The list
uses a two-pixel top offset and four-pixel gaps, including below the divider.
Header and child Tool triggers share one fixed sixteen-pixel trailing caret
column. Labels and visible metadata wrap independently of that column; existing
responsive metadata visibility and coarse-pointer targets remain.

The existing Message, Bubble, Marker, Collapsible and Dialog primitives own their
content and interactions. WindowedTranscript additionally retains at most one
focused row outside its ordinary window, including while its portaled dialog is
open. This prevents virtualization from disposing that dialog or its native
opener. Moving focus outside the interaction releases the row. Bottom settling checks
the logical content end as well as the DOM end because direct DOM sizing can
trail a replaced snapshot by a frame. The virtualizer owns the existing responsive
inter-row gap directly, so appending a row updates spacing and unread geometry
atomically without changing the preceding row's measured content height. Scrolling,
anchor compensation, disclosure persistence, optimistic identity and composer
handoff remain with their existing owners.

## Tradeoffs and verification

The rails recover header height while reducing line length, especially at 320
pixels. Timestamp access is quieter than a visible clock on every row. Icon
recognition requires rendered inspection as well as accessible names. The empty
action rail deliberately spends width to keep reading alignment stable.

Synthetic browser fixtures check 1440/800/390/320-pixel layouts, coarse pointers,
reduced motion, zoom and long-content overflow, identity names, semantic time,
retained Human chrome, voice evidence and focus restoration, activity summary
truth, child disclosure state, absent rules, bounded windowing and retained dialog
ownership. Existing source, scroll, measured disclosure, composer and optimistic
submission regressions remain required. No backend/history/media behavior changes.
Source integration does not authorize installing or restarting a live service.
