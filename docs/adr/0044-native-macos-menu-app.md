# 0044: A native macOS menu app observes the waiting server

Accepted September 10, 2026 by the operator. Extends [0025](0025-launchagent-default-workspaces.md)
without changing the waiting server or workspace lifecycle, and preserves the
microphone identity retained by [0027](0027-service-microphone-identity.md) and
[0033](0033-client-owned-native-media.md).

## Decision

The macOS installer places a signed `AgentVoice.app` in the user's Applications
directory. It is an AppKit menu-bar app with the agent activation policy and a
native status item. The first surface is intentionally small: the current
launchd state of the default waiting server, **Run AgentVoice at login**, and
**Quit AgentVoice Menu**. A launchd `running` state says only that the waiting
job is running; it is not a Codex, account, media, or call readiness claim.

The menu app is not another server supervisor and never connects as a frontend
to test readiness. The existing installer-owned `io.arthack.agentvoice.server`
LaunchAgent continues to own the default server, KeepAlive, logs, environment,
and service replacement. Consequently quitting the menu app, disabling its login
item, or updating its UI does not stop an Android or terminal call. Explicit
service restart/removal retains its existing call-ending semantics.

`SMAppService.mainApp` owns the menu app's login setting. Enabled means macOS may
open the menu app on subsequent logins. Disabling it leaves the current menu app
and the separate waiting server running, matching the platform API. On its first
launch, the app records and applies an enabled default once; later launches and
updates never overwrite an explicit opt-out. A failed default registration stays
available as a manual action rather than creating a startup alert or repeated
prompt. Revoked approval becomes an explicit **Open Login Item Settings…** action
rather than an invented enabled state.

The menu app uses the bundle identifier `io.arthack.agentvoice.menu`. The private
signed Bun runtime under AgentVoice state keeps `io.arthack.agentvoice`, its
stable designated requirement, microphone entitlement, receipt, and both server
and native-client responsibilities. The two bundles are intentionally distinct;
packaging a visible app is not permission to rename or replace the runtime's TCC
identity.

## Packaging and UI boundary

App source lives under `macos/`, built with the installed Swift toolchain and
packaged by `scripts/build-macos-app.sh`. The editable installer atomically
publishes only an ownership-marked, source-revision-matched, strictly verified
bundle. It leaves an already-current running app untouched and refuses to replace
a changed running app or an unrelated destination. `--command-only` installs
neither this app nor the LaunchAgent.

AppKit owns the status item and menu, following the native patterns established
in AgentNotify. Future windows or popovers should reuse AgentNotify's AppKit and
SwiftUI structure, semantic colors, system typography, accessibility behavior,
and real-render verification as a reference. This record does not select a
future call-control or conversation UI. Adding one must preserve client-owned
media, exclusive frontend admission, and truthful controller identity rather
than inferring call readiness from launchd.

## Consequences

The menu can be present or absent independently of server and call lifetime.
There is one server supervisor, not two. The installer now requires the macOS
Swift command-line tools for a full install, while command-only and non-macOS
installation keep their existing scope. The first app has no automatic
waiting-server mutation, call button, microphone access, Codex login probe, or
native-history access; those require later product decisions and focused lifecycle tests.
