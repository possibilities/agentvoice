# 0071: Restore a marked workspace session at server start

Accepted September 15, 2026 at the operator's request after a server restart left
the live web reader empty until a voice client connected. Supersedes only the
first-frontend lazy-start and default-selection timing in
[0024](0024-server-and-pointer-frontend.md),
[0025](0025-launchagent-default-workspaces.md),
[0053](0053-retain-workspace-session-across-frontend-detach.md), and the marked
case of the valid web empty state in
[0060](0060-web-session-and-browser-process-continuity.md). Their media ownership,
retention, security, and markerless lazy-start decisions remain.

## Decision

At server launch, inspect the explicitly selected workspace or the current managed
default generation without creating a new generation. When that workspace has a
valid `.agentvoice-session` marker, pin it immediately and restore one detached
workspace-session controller, runtime, owned stock Codex child, and the marker's
exact verified native root thread. This happens without a frontend connection or
media reservation so web history, native work, attachments, control, and event
observation exist for the server lifetime.

Detached restoration opens no production audio, WebRTC peer, or native realtime
voice session. Both channels are effectively muted. A later sole frontend makes
the normal explicit media attachment to that same controller and thread; it does
not create or resume another backend session. Reattachment keeps the existing
fresh-media, no-replay, detach-fencing, and one-owner rules.

If no default workspace exists, or the selected workspace has no marker, retain
the lazy behavior: bind the waiting server without starting Codex, and let the
first frontend select/pin the applicable workspace and create its root thread.
Startup discovery must not create a managed generation merely to look for work or
emit an error for this valid new-install state.

An unsafe, invalid, or unresumable marker is never replaced, deleted, or bypassed.
Report the restoration failure and preserve the exact marker and native history;
do not fall back to a new thread. Explicit `new_session` remains the supported way
to replace a valid retained root once a controller exists.

## Consequences and verification

Server and media lifetimes are now visibly independent across process restarts:
the LaunchAgent may restore native work before any terminal, phone, or Android
client exists, while only a client can start audible voice. The web reader remains
read-only and no longer needs a media client to prime a saved conversation after
server restart. Configuration, prompts, roles, and the stock child load at server
startup for marked workspaces, just as they previously loaded on first attachment.

Tests must cover both branches. A markerless real server stays waiting without a
Codex child. A marked real default server performs exact `thread/read` plus
`thread/resume`, exposes retained identity while media availability is idle,
starts no native realtime session, and lets a later frontend reuse the same
controller generation without `thread/start`.
