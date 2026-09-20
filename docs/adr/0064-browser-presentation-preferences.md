# 0064: Browser presentation preferences

Status: Superseded by [ADR 0102](0102-agent-only-web-transcript.md).

Accepted 2026-09-14 at the operator's request.

The transcript reader offers Agent, Voice, and Both views; Both remains the
initial default. A responsive app header makes the choice available during loading
and reconnect, alongside branding, the current-view label and reserved status text.
It replaces duplicate pane headings; pane regions retain accessible names. Concealed panes remain mounted, inert and measured, preserving their
composer, disclosure and follow state while current history continues updating.

The selected view is a browser presentation preference, not workspace-session
state or action authority. Store its small validated value synchronously on
selection in origin-local storage, scoped by the existing stable Funk kiosk
instance when present. It survives call replacement and browser/kiosk process
restart with the same origin, profile, and instance. Ordinary tabs share the
saved default but do not force live changes onto one another. No sessionStorage
identity or unload write is required.

Unknown values and unavailable reads use Both. A failed write preserves the
current choice in memory and displays that it applies only to this visit. Storage
clearing, eviction, private profiles and platform failure can prevent recovery;
this is best effort, not an unconditional durability guarantee.

Existing Steer/Queue choices already persist with composer recovery. No new
presentation controls are introduced beyond pane selection. Scroll/follow intent,
expanded transcript details, loading state, connection state, and active work
remain current-session state rather than durable defaults. Draft recovery keeps
its separate scoped contract in [0058](0058-durable-web-composer-and-reader-recovery.md)
and [0060](0060-web-session-and-browser-process-continuity.md).

Verify hidden-pane updates and reading anchors, drafts, reconnect/reload,
invalid/blocked storage, responsive keyboard controls, and new contexts without
sessionStorage. Use the offscreen Funk storage harness with the built app and
fixture-only HTTP API to verify immediate process exit/reopen without touching a
live kiosk or call. Serving changes require only the separately authorized UI
reader refresh; native runtime and kiosk restarts remain separate actions.
