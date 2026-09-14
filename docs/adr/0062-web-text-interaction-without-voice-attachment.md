# 0062: Web text interaction without voice attachment

Accepted 2026-09-14 at the operator's request. Supersedes only the requirement
for a voice frontend attachment in [0060](0060-web-session-and-browser-process-continuity.md).
Retains its history, persistence and served-code verification decisions.

## Decision

The Agent composer operates against the retained native workspace session.
A voice frontend attachment does not grant or revoke text interaction authority.
Send, Steer and Queue remain available when the reader has verified the exact
current controller, generation, workspace and thread through reachable native
transports. Detaching media alone does not replace the text view or pause its queue.

A running server that has never created a session is a legitimate empty state;
reading it does not create a session or attach voice. Unavailable or unverified
native transports disable submission while retaining verified history and editable
drafts. Confirmed session replacement invalidates old actions and selects the
new session's persistence scope. Reconnection must revalidate authority before
dispatching, including checks after asynchronous reads and before mutation.

Queue ordering, unknown acceptance and explicit recovery keep their existing
semantics. Draft recovery never creates action authority or automatically resends
pending input. A media attachment change is informational for text interaction;
the native session's lifetime remains governed by
[0053](0053-retain-workspace-session-across-frontend-detach.md).

## Verification and activation

Use isolated native/control fixtures for detached Send, Steer and queue draining,
transport failure, empty servers, reconnection and confirmed replacement. Browser
fixtures verify enabled state and draft continuity without controlling live media.
Verify the actual named-origin host code after any required UI-reader-only refresh;
native server, call, Codex and kiosk restarts are separate actions.
