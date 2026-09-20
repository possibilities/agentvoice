# 0072: Retire terminal composition and attachment commands

Accepted 2026-09-15 at the operator's request. Supersedes the terminal-facing
parts of [0021](0021-guarded-tui-attachment.md),
[0022](0022-websocket-native-tui.md),
[0026](0026-persistent-voice-transcripts.md), and
[0052](0052-workspace-session-marker.md). Fully supersedes
[0028](0028-foreground-composition.md),
[0036](0036-desktop-mobile-attachment.md),
[0037](0037-descendant-tui-attachment.md), and
[0050](0050-correlated-native-hook-trust.md). The earlier records remain as
history for those retired designs.

## Decision

Bare `agentvoice` prints help. `agentvoice client` remains the explicit pointer
and voice frontend. The server, service, phone, network, role, MCP, event and
thread commands keep their existing ownership.

The AgentVoice web UI is the durable transcript surface and the
host-side typed Agent input surface. Remove the bare-command smolmux composition,
desktop `--attach` view, `attach agent`, `attach voice`, SSH transcript bridge,
stock Codex TUI launcher, codex-viewer integration and their private framing and
selection machinery. Persistent voice recording remains server-owned, and the web
reader retains its bounded identity, inode, permission and size checks. [ADR 0102](0102-agent-only-web-transcript.md)
later removes raw Voice rendering while preserving that server boundary.

Keep the runtime-owned authenticated loopback gateway because the web composer
and explicit speech helper use it. Narrow each ticket to the exact current root
thread and expose only initialization, turn start, turn steer, turn interrupt and
`thread/realtime/appendSpeech`. The gateway rejects reads, settings, descendant
navigation, native-question answers and all other methods before native dispatch.
Browser code receives neither the native credential nor an executable path.

Native Codex owns approval, tool-question and elicitation prompts. AgentVoice may
report that a request exists, but it does not answer or forward answers for those
native prompts.

## Consequences

Terminal composition and attachment dependencies are no longer installation
requirements. Operators open `https://agentvoice.localhost` for transcripts and
typed input, and run `agentvoice client` only when they want the pointer/audio
frontend.

Runtime replacement and server shutdown still revoke issued gateway tickets.
Frontend or media detachment does not revoke host text authority for the retained
workspace session. Gateway acceptance remains distinct from turn completion or
speech playback, and callers do not retry input automatically.

## Verification

CLI tests require bare help, explicit client help and rejection of every retired
entry point. Gateway tests exercise authentication, watcher ordering, exact-root
method filtering, correlation, token redaction and revocation. Web tests cover
Send/Steer/Interrupt against the narrowed ticket and bounded voice-recording reads.
Repository checks must also prove that terminal launcher, SSH, smolmux and
codex-viewer references remain only in historical decision records.
