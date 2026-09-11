# macOS menu app

The installed `~/Applications/AgentVoice.app` is the native home for AgentVoice
in the macOS menu bar. It is deliberately independent from the waiting server:
opening or quitting the menu does not start or stop a call, and it never opens
audio or Codex to test readiness.

The menu currently contains:

- the default LaunchAgent's current launchd state;
- **Pair phone…**, which opens a reusable native pairing window;
- **Run at login**, backed by `SMAppService.mainApp` and enabled by
  default on the app's first launch;
- **Open Login Item Settings…** when macOS requires approval; and
- **Quit menu**, which leaves the server and any call running.

“AgentVoice is running” reports the job state only. It does not establish
account authentication, media readiness, frontend admission, or a live call.
Use the existing terminal clients to start calls and `agentvoice service` for
explicit service management.

The pairing window asks the waiting server for a five-minute, one-use enrollment
code through a private Unix socket. It makes the code redeemable only after the QR
has been displayed, requests cancellation of an unredeemed code when closed, and reports loading,
waiting, paired, expired and retry states. A paired phone has no time-based expiry;
it remains trusted until `agentvoice network revoke <id>`. Pairing and challenge
verification cannot start a call, Codex or media. The same fixed window is raised
on repeated menu selection and remains open when focus moves to the phone.

## Build and verify

```sh
bun run macos:check
bun run macos:build
dist/AgentVoice.app/Contents/MacOS/AgentVoice --version
```

The build uses AppKit, SwiftUI, Core Image, ServiceManagement, SF Symbols, and a
generated original application icon. The bundle records the exact AgentVoice
state directory selected by the installer so its private pairing socket matches
the LaunchAgent. Building alone creates no login item and starts no service or
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
