# 0070: Preserve menu presence during app-only updates

Accepted September 15, 2026 through the operator's request for installer-owned
graceful menu updates. Extends [0044](0044-native-macos-menu-app.md) and
[0065](0065-native-menu-server-lifecycle.md) without changing the waiting-server
or call lifecycle in [0025](0025-launchagent-default-workspaces.md).

## Decision

Add an explicit `--quit-menu` installer opt-in. When an owned, signed, outdated
AgentVoice menu app is running and supports the versioned update-control
protocol, the installer asks that exact instance to quit, waits boundedly for
confirmed exit, atomically replaces the bundle, and reopens the exact installed
bundle only because it observed the old one running. Current or previously
stopped apps keep their presence unchanged.

The app owns the quit decision through a private Unix socket below its stamped
AgentVoice state directory. A version-1 request carries the expected source
revision; the server admits only its logged-in user, reports its process and
revision, applies the same busy gate as **Quit AgentVoice menu**, and calls the
same `NSApplication.terminate` path. The command-side client verifies private
socket ownership, the kernel-reported peer process, response identity, and the
exact expected revision. Its bounded success means the accepted app instance
has exited. It does not invoke a service action, login-item mutation, frontend,
audio, or Codex.

The installer retains its bundle-identifier, installer-marker, source-revision,
ownership, designated-requirement, and exact-executable checks before it sends a
request. These checks and same-user kernel credentials prevent accidental
cross-app control; the ad-hoc identifier-only signature is not publisher or team
authentication and the control is not a security boundary against malicious
code already running as the user.

There is no signal, AppleScript, `NSRunningApplication`, or forced-quit fallback.
A refusal, incompatible response, identity mismatch, lost outcome, or timeout
leaves the old bundle untouched. If a later publication step fails after a
confirmed quit, the atomic installer restores the old bundle and asks the exact
preserved app to reopen. If the new bundle installs but reopening fails, the
installer reports that partial outcome clearly instead of claiming presence.

## Separate installer scopes

Add `--menu-only` so a menu update never implies a server restart. It builds and
publishes only `AgentVoice.app`; it does not build native audio, publish the
editable command or deployed receipt, or call the LaunchAgent service layer.
`--menu-only --quit-menu` is therefore the ordinary presence-preserving menu
update. The full installer retains its existing command, menu, and LaunchAgent
convergence and still restarts the waiting server. `--quit-menu` changes only
the menu-process step in that full flow. `--command-only` remains mutually
exclusive with menu flags.

## Bootstrap and verification

Installed versions before this decision have no control protocol. The first
upgrade from a running legacy version refuses with one manual instruction:
choose **Quit AgentVoice menu**, rerun the menu-only installer, and open the new
app once. A stopped legacy app upgrades normally. Every later supported update
can preserve menu presence automatically.

Disposable installer and bundle fixtures cover absent, current, stopped,
supported running, and legacy running apps; opt-in refusal; exact bundle and
executable identity; timeout and lost-exit outcomes; atomic replacement and
rollback; conditional relaunch; and the absence of LaunchAgent calls in
menu-only scope. Swift compilation covers the app-owned endpoint and CLI mode;
the checks do not launch the menu or exercise a live Unix peer. Build and test
workflows do not launch the menu, server, call, audio, or Codex. The first real
protocol exchange and activation of the supported installed version remain a
manual desktop step.
