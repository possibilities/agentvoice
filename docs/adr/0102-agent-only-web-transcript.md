# 0102: Present one Agent transcript in the web UI

Accepted 2026-09-20 at the operator's request. Supersedes the pane-selection UI
in [0064](0064-browser-presentation-preferences.md) and refines the presentation
requirements in [0057](0057-responsive-web-transcripts.md),
[0074](0074-fail-closed-voice-history.md), and
[0075](0075-own-web-transcript-ui.md).

## Decision

The AgentVoice web page renders one Agent transcript and its composer. It has no
page header, AgentVoice masthead, Agent/Voice/Both selector, raw Voice lane,
alignment placeholder, or pane preference. Required loading, reconnect, and
offline status appears only when needed inside the transcript surface and reserves
no space during the ordinary live state. Agent history reveals as soon as its own
initial pass is ready; raw Voice history readiness cannot hold it.

The Agent stream remains the complete projected conversation surface. Human
messages created by native voice delegation keep their readable body and complete
details dialog. A small microphone button immediately beside `Human` opens those
details with a precise accessible name and no tooltip or duplicate visible source
label. Internal `Via Voice` provenance continues to identify those rows. System, routing, tool,
file-change, and unavailable events remain in their existing order and retain
stable row identities. [ADR 0105](0105-compose-transcript-events-from-primitives.md)
maps their presentation into the single generic Tool call primitive and removes
subagent lifecycle rows from the web transcript.

The composer has no visible Send button, follow-up-mode menu, or attachment
picker. Enter submits, Shift+Enter inserts a line break, an idle submission uses
`send`, and an active-turn submission uses `steer`. The web UI cannot create
queued submissions. Existing host-owned queue rows remain visible with their
truthful text, images, pause reason, disabled state, and Remove action; their
other mutation controls are absent. Clipboard-image paste and local-path
paste/drop retain their validation, preview, removal, persistence, and failure
recovery. The textarea takes the space formerly occupied by composer controls and
keeps explicit accessible keyboard/drop instructions.

The composer is the conversation's default text focus. Printable input from the
noninteractive transcript appends at the end of the recovered draft and moves
focus to the textarea. Plain Page Up, Page Down, Home, and End in the textarea
move the transcript by a viewport or to an edge without changing focus or draft
bytes. Safe pointer completion of a temporary interaction restores the composer
at the end of the draft. Text selection, editable and interactive controls,
dialogs, menus, document reading, modified shortcuts, browser navigation, and
IME composition retain their native focus and keyboard behavior. Keyboard or
Escape closure of a disclosure or viewer returns focus to its native opener.

An accepted local Human submission remains one stable optimistic row while an
exact native echo is still streaming. The completed exact client identity replaces
it with source-exact canonical content. This prevents transient native fragments
from overlapping preserved code blocks, and presents pending images as attachment
counts instead of raw canonical `[Image #N]` text. Pending and unknown delivery,
draft recovery, and attachment recovery remain truthful until completion.

## Boundaries

Persistent private voice JSONL, live voice events, `LiveView.voice`, voice-history
loading/notices, HTTP contracts, and control actions remain server-owned and
compatible. Removing their web presentation does not erase recordings, reinterpret
saved speech, feed it into realtime input, or retire queue and file-list APIs used
by other clients. Historical pane-preference bytes are ignored and left inert.

## Verification

Browser coverage checks desktop and mobile geometry, the missing header and
preference controls, Agent-only reveal while Voice history is loading, absence of
raw Voice rows, keyboard and drop accessibility, automatic send/steer, immutable
queue creation, retained queue removal, image validation/previews, every projected
event family, and the voice microphone/details dialog without a visible source label. It also checks transcript
typing handoff, page and edge navigation under reduced motion, focus restoration,
draft/caret preservation, and modifier, selection, interactive-control, dialog,
and IME exclusions. Existing transcript
windowing, scrolling, disclosure, recovery, API, build, typecheck, and repository
checks remain required. Source delivery does not authorize installing or restarting
the live server.
