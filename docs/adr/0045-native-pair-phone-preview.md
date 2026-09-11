# 0045: Pair phone begins as a persistent native interaction preview

Accepted September 11, 2026 by the operator; superseded for credential behavior
by [0046](0046-durable-device-pairing.md). Extends
[0044](0044-native-macos-menu-app.md) without changing device grants, the network
gateway, Android enrollment or call ownership.

## Decision

The AgentVoice menu adds **Pair phone…**. It opens one fixed-size, titled,
closable, non-modal macOS window and raises that same window on repeated
selection. The window opens at normal window level, stays available when focus
moves to the phone, and closes through its title-bar control, Escape or **Done**.
It is neither a dismiss-on-blur popover nor an always-on-top floating palette.

AppKit owns the window lifecycle and hosts SwiftUI content, following
AgentNotify's native Preferences-window boundary. The first slice existed to
settle layout and interaction only. It generated a QR from the explicit
`agentvoice-preview:v1:` namespace, which Android rejects. Opening, scanning or
closing it cannot issue or activate a grant, read credentials, connect to the
waiting server, start Codex, request microphone access or begin a call. The UI
says that pairing is not connected yet and contains no temporary-expiry claim.

## Consequences

The human could review the real desktop pairing surface without creating a secret
or coupling its design to the reusable 30-day bearer credential.
[0046](0046-durable-device-pairing.md) now wires the window with atomic private QR
presentation, activation only after successful display, redacted diagnostics,
durable device identity and revocation. The window and lifecycle decision here
remain current.
