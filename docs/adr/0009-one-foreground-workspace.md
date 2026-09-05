# 0009: One foreground app, one workspace per launch

Accepted 2026-09-04. Supersedes the topology in ADRs 0002–0005.

Bare AgentVoice now runs its TUI, audio, WebRTC and coordination in one process.
It owns a stock Codex app-server child over native stdio. No Codex fork, embed,
background Server, resident service, remote client or replacement supervisor.
Console remains an alias. Quitting stops work and closes the child, while
native saved conversation history remains resumable.

Resolve one canonical existing workspace at launch, default launch cwd; CLI
beats explicit file workspace. Use it for history selection and all threads.
Reject conflicting cwd/identity passthroughs. Continue the newest eligible
unarchived AgentVoice main thread in that exact directory, using native list
pagination and resume. Fresh/no-continue creates a new conversation; explicit
resume must match this inventory. Errors never silently become Fresh.

Per-thread kernel locks prevent simultaneous AgentVoice owners without a
machine-wide singleton. Old parents keep their locks and worker managers after
Fresh; reports capture parent identity and cannot move into the new thread.
Fresh cuts media before switching. No global thread.json, worker persistence,
restart adoption or transcript-copy layer is used. Legacy private state stays.

Retire remote/phone/pairing/discovery/control-protocol/Android code and normal
service-management commands. Retired verbs and remote config fail clearly.
Previously installed services are not automatically stopped or uninstalled;
they do not participate in the new locks and require explicit migration.

Preserve config/prompt paths, media controls, optional dispatch/reporting and
account balancing. Rotation replaces only this app's child at idle. Native
voice-context policy, permissions, skill isolation and --fast remain separate.
Workspace-local selection is not memory isolation or a filesystem sandbox.

Verification: fake child stdio framing/failure/shutdown, real cross-process
locks/crash release, native stock initialize/list probe, workspace/resume and
worker-parent regressions, injected-media TUI tests, and terminal-controlled
foreground smoke without a microphone or inference. Live voice/account behavior
is a separate opt-in check. No installs, service changes, archive edits or pushes.
