# 0060: Web session and browser-process continuity

Accepted 2026-09-14 at the operator's request. Refines
[0058](0058-durable-web-composer-and-reader-recovery.md) and applies the retained
workspace-session ownership established in
[0053](0053-retain-workspace-session-across-frontend-detach.md).

The voice-attachment requirement for composer actions below is superseded by
[0062](0062-web-text-interaction-without-voice-attachment.md). Other decisions remain active.

## Evidence

The running web reader served an old optimized transcript package after the new
package was installed and built. Its API and host module were current, but its
composer module did not contain persistence support. Reopening the kiosk loaded
that same old module. A build receipt therefore did not establish browser delivery.
[Vite documents separate optimized dependency and browser caches](https://vite.dev/guide/dep-pre-bundling#caching);
restarting the browser does not refresh the server's dependency graph.

An isolated native WKWebView harness then demonstrated a second problem in the
new package: its persistent data store retained localStorage across actual process
exits, but sessionStorage identity changed. Existing text appeared only as a
recovery card while the main textarea was empty. Immediate native termination
before the 120 ms write timer also lost newly typed text. Cross-process WKWebViews
did not share Web Locks or BroadcastChannel ownership observations in that probe.

## Decision

The web UI observes the waiting server and its retained workspace session. A
voice frontend attachment is required for composer actions, not for viewing
retained authoritative history. A running server with no session yet is a valid
empty state. Reader transport failure, frontend detach and actual session
replacement remain distinct; observation must not create a session or reconnect
media. Cached text alone never establishes live authority or freshness.

A native single-window browser context may supply an explicit stable persistence
instance identity through the generic Funk document-start bridge
`window.funkKiosk.persistenceInstanceId`; AgentVoice forwards it to the shared
composer. Ordinary browser tabs retain separate ephemeral tab identities;
they do not automatically adopt another tab's active draft. Workspace/thread scope
continues to isolate conversations regardless of the browser instance identity.
Pending delivery remains separate from draft recovery and is never replayed.
A compact synchronous entry journal protects committed textarea changes before
the batched full-record write. Its recovery must preserve both queued edits and
the main draft saved before editing, without replaying a queued mutation.

Dependency installation and served-code activation are separate delivery steps.
After changing the shared package, verify the actual module served at the named
origin and the native process-restart fixture. Coordinate any required web-reader
refresh separately from the native server, call, Codex process and kiosk.

## Limits

Browser-local persistence remains best effort against storage denial, quota,
eviction, clearing and platform termination. A stable persistence instance ID is
a host ownership contract, not authentication. Separate active browser contexts
must not intentionally share it. No browser recovery grants native action
authority, and a newly verified session cannot inherit another session's state.
