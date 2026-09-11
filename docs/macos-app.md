# macOS menu app

The installed `~/Applications/AgentVoice.app` is the native home for AgentVoice
in the macOS menu bar. It is deliberately independent from the waiting server:
opening or quitting the menu does not start or stop a call, and it never opens
audio or Codex to test readiness.

The menu currently contains:

- the default LaunchAgent's current launchd state;
- **Run AgentVoice at login**, backed by `SMAppService.mainApp` and enabled by
  default on the app's first launch;
- **Open Login Item Settings…** when macOS requires approval; and
- **Quit AgentVoice Menu**, which leaves the server and any call running.

“AgentVoice is running” reports the job state only. It does not establish
account authentication, media readiness, frontend admission, or a live call.
Use the existing terminal clients to start calls and `agentvoice service` for
explicit service management.

## Build and verify

```sh
bun run macos:check
bun run macos:build
dist/AgentVoice.app/Contents/MacOS/AgentVoice --version
```

The build uses AppKit, ServiceManagement, SF Symbols, and a generated original
application icon. Building alone creates no login item and starts no service or
media. The first menu-app launch registers it to run at login once; a later user
opt-out is preserved. The full editable installer adds the signed bundle to
`~/Applications`; use
`AGENTVOICE_INSTALL_APP_DIR` for a disposable absolute destination. A changed
running app must be quit before replacement. An already-current running app is
left untouched.

`scripts/install.sh --install --command-only` continues to publish only the CLI
and its receipt. It neither builds nor installs the menu app and does not manage
the LaunchAgent.

## Future native UI

Use `~/code/agentnotify` as the standing implementation reference for any panel,
popover, settings window, or semantic UI control added to this app. In
particular, preserve AppKit ownership of menu/window lifecycle, SwiftUI for shared
content where useful, semantic system colors and typography, accessible labels
and focus, one authoritative model, and verification of the actual native render
in light and dark appearances. AgentVoice's server/controller and client-media
contracts remain authoritative over any visual convenience.
