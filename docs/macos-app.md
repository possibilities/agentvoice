# macOS menu app

The installed `~/Applications/AgentVoice.app` is the native home for AgentVoice
in the macOS menu bar. It is deliberately independent from the waiting server:
opening or quitting the menu does not start or stop a call, and it never opens
audio or Codex to test readiness.

The menu shows **AgentVoice is running**, **AgentVoice is loaded**, or
**AgentVoice is unloaded**, followed by the actions available for that state:

- **Load AgentVoice** loads the existing server installation. It does not start a call.
- **Restart AgentVoice…** ends any call and background work in the default server,
  then starts the server again. Reconnect a client to call again.
- **Unload AgentVoice…** ends any call and background work, keeping the installation,
  settings, logs, and paired phones. It stays unloaded until you load it or sign in
  to your Mac again. This does not disable its next-login LaunchAgent behavior.
- **Pair phone…** opens the reusable native pairing window.
- **Show menu at login** controls only the menu app and is enabled on its first launch.
  **Open login item settings…** appears when macOS requires approval.
- **Quit AgentVoice menu** leaves the server and any call running.

Restart and unload ask for confirmation because both stop retained background
work, even when no call is attached. Progress is visible when reopening the menu;
other server actions and quitting the menu are disabled until the request finishes.
Errors have a details action and a status recheck; a failed request is never
retried automatically. Unknown inspection results never appear as unloaded.

“AgentVoice is running” describes launchd's server job only. “AgentVoice is loaded”
means the job is registered but running status is not confirmed. Neither establishes
account authentication, media readiness, frontend admission, or a live call.
A missing installation asks for reinstallation rather than offering to fabricate
one. The equivalent terminal commands are `agentvoice service load`, `unload`,
and `restart`; `status --json` returns a version-1 machine-readable state.
`remove` remains a separate CLI operation that deletes the owned LaunchAgent plist.

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
state directory and fixed service executable/source selected by the installer.
The private pairing socket matches the LaunchAgent, and lifecycle actions invoke
that fixed command without a shell or PATH lookup. The existing service layer
validates installation ownership and serializes changes with the installer's lock. Building alone creates no login item and starts no service or
media. The first menu-app launch registers it to run at login once; a later user
opt-out is preserved. The full editable installer adds the signed bundle to
`~/Applications`; use
`AGENTVOICE_INSTALL_APP_DIR` for a disposable absolute destination. A changed
running app is replaced only with the explicit `--quit-menu` opt-in. The
installer asks that exact owned app to quit through its private versioned control
socket, waits boundedly, publishes the update, and reopens it only when it was
running before the update. A refusal, timeout, or identity mismatch stops before
replacement; there is no forced-quit fallback. An already-current running app is
left untouched.

Use `scripts/install.sh --install --menu-only --quit-menu` to update and preserve
the menu app without reinstalling or restarting the waiting-server LaunchAgent.
This scope does not build native audio, publish the command, change the deployed
receipt, or interrupt a call. The ordinary full installer still updates all three
components and restarts the server as before; `--quit-menu` changes only how it
handles an outdated running menu app.

AgentVoice menu versions installed before the private control protocol cannot
quit themselves for an update. The first upgrade from one of those versions
clearly refuses: choose **Quit AgentVoice menu**, rerun the menu-only installer,
then open the newly installed app once. After that one-time bootstrap, future
menu updates can preserve running presence with `--quit-menu`.

`scripts/install.sh --install --command-only` continues to publish only the CLI
and its receipt after preparing frozen web dependencies and verifying one production
reader build. It neither builds nor installs the menu app and does not manage the
LaunchAgent.

## Future native UI

Use `~/code/agentnotify` as the standing implementation reference for any panel,
popover, settings window, or semantic UI control added to this app. In
particular, preserve AppKit ownership of menu/window lifecycle, SwiftUI for shared
content where useful, semantic system colors and typography, accessible labels
and focus, one authoritative model, and verification of the actual native render
in light and dark appearances. AgentVoice's server/controller and client-media
contracts remain authoritative over any visual convenience.
