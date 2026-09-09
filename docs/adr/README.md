# agentvoice decision log

Read the relevant records before changing a boundary they explain. Current
implementation and procedures live in the repository's guidance and architecture
documents; an old record preserves why an earlier choice was made.

“Recorded” means the original record did not declare an acceptance status.
It does not invent an approval date or promise that every implementation detail
remains current. Explicit supersession below names the changed scope; the
record itself retains the original reasoning and replacement links. A dash adds
no status claim beyond the record; it does not certify every detail as current.

| Decision | Status | Replacement or current scope |
|---|---|---|
| [0001: Retire Worker threads after task settlement](0001-retire-worker-threads.md) | Recorded | Worker retirement after task settlement. |
| [0002: Remote console attaches to the Client](0002-remote-console-attaches-to-client.md) | Superseded | [0009](0009-one-foreground-workspace.md). |
| [0003: The Remote console crosses machines over a tailnet WebSocket](0003-remote-console-crosses-machines-over-the-tailnet.md) | Superseded | [0009](0009-one-foreground-workspace.md). |
| [0004: A resident Server owns the coordination runtime](0004-a-resident-server-owns-the-coordination-runtime.md) | Superseded | [0009](0009-one-foreground-workspace.md). |
| [0005: Pair once and race authenticated routes](0005-pair-once-and-race-authenticated-routes.md) | Superseded | [0009](0009-one-foreground-workspace.md). |
| [0006: Enable fixed AgentStart skills per thread](0006-enable-fixed-agentstart-skills-per-thread.md) | Superseded | [0007](0007-defer-skill-policy-to-codex.md). |
| [0007: Defer skill policy to Codex](0007-defer-skill-policy-to-codex.md) | Accepted | — |
| [0008: Keep voice-context controls native](0008-keep-voice-context-controls-native.md) | Partially superseded | [0011](0011-spoken-history-continuity.md) changed replay/startup context; [0017](0017-remove-spoken-history-replay.md) removed replay and [0029](0029-desktop-startup-context.md) records the current startup default. |
| [0009: One foreground app, one workspace per launch](0009-one-foreground-workspace.md) | Partially superseded | [0015](0015-retain-controller-replace-runtime.md) replaces the single process, [0020](0020-native-launch-defaults.md) replaces launch defaults, [0024](0024-server-and-pointer-frontend.md) replaces foreground-only ownership, and [0033](0033-client-owned-native-media.md) moves media to clients. Exact native identity and explicit continuation remain. |
| [0010: Quiet voice reconnects](0010-quiet-voice-resume.md) | Superseded | [0012](0012-vanilla-voice-reconnects.md); quiet-resume instructions remain retired. |
| [0011: Continue the spoken conversation](0011-spoken-history-continuity.md) | Superseded for replay/defaults | [0017](0017-remove-spoken-history-replay.md), [0020](0020-native-launch-defaults.md), and [0029](0029-desktop-startup-context.md). Historical probes remain evidence. |
| [0012: Reconnect voice calls without AgentVoice instructions](0012-vanilla-voice-reconnects.md) | Partially superseded | [0017](0017-remove-spoken-history-replay.md) removes the replay exception; [0019](0019-client-server-default-baseline.md) clarifies the native client/server baseline. |
| [0013: Convention prompt files, one native control each](0013-convention-prompt-files.md) | Accepted | — |
| [0014: Roles are directories delivered to the owned child](0014-roles.md) | Accepted | — |
| [0015: Retain the foreground controller, replace the voice runtime](0015-retain-controller-replace-runtime.md) | Partially superseded | [0024](0024-server-and-pointer-frontend.md) moves the retained controller/runtime under the waiting server; [0033](0033-client-owned-native-media.md) moves native media to clients. Runtime replacement, owned Codex cleanup and journaled operations remain. |
| [0016: Submit an optional handoff after runtime restart](0016-restart-handoff.md) | Accepted | — |
| [0017: Remove automatic spoken-history replay](0017-remove-spoken-history-replay.md) | Recorded | — |
| [0018: Observe lifecycle state through a separate Unix socket](0018-read-only-lifecycle-event-socket.md) | Partially superseded | [0026](0026-persistent-voice-transcripts.md) adds a separate persistent voice-transcript writer. The live event feed remains transient, lifecycle snapshots remain content-free, and their watermarks do not promise transcript replay. |
| [0019: Compare defaults against the Codex client and server together](0019-client-server-default-baseline.md) | Recorded | — |
| [0020: Native permissions and context, fresh ordinary launches](0020-native-launch-defaults.md) | Partially superseded | [0029](0029-desktop-startup-context.md) replaces only the startup-context default. |
| [0021: Attach a stock TUI through a guarded local gateway](0021-guarded-tui-attachment.md) | Partially superseded | [0022](0022-websocket-native-tui.md) replaces opt-in transport and admission gates; the owned local attachment boundary remains. |
| [0022: WebSocket-only RPC and native TUI interaction](0022-websocket-native-tui.md) | Accepted | — |
| [0023: Conversation observation for independent UIs](0023-conversation-observation.md) | Recorded | — |
| [0024: Waiting local server and pointer-only frontend](0024-server-and-pointer-frontend.md) | Partially superseded | [0025](0025-launchagent-default-workspaces.md) supplies the default service/workspace lifecycle and [0033](0033-client-owned-native-media.md) moves audio/WebRTC to clients. The waiting server and pointer frontend remain. |
| [0025: LaunchAgent and default workspace generations](0025-launchagent-default-workspaces.md) | Accepted | — |
| [0026: Persistent workspace voice transcripts](0026-persistent-voice-transcripts.md) | Recorded | — |
| [0027: A microphone identity for the LaunchAgent](0027-service-microphone-identity.md) | Partially superseded | [0033](0033-client-owned-native-media.md) moves microphone use to the client. The installer-owned signed runtime, stable permission identity and operator-owned consent remain.
| [0028: Bare command composes local terminal apps](0028-foreground-composition.md) | Accepted | — |
| [0029: Desktop startup-context default](0029-desktop-startup-context.md) | Recorded | — |
| [0030: Conversation-first delegation through native operator configuration](0030-conversation-first-delegation.md) | Superseded for configuration ownership | [0031](0031-role-owned-delegation.md) moves delegation mode to the selected role. |
| [0031: The selected role owns its native delegation mode](0031-role-owned-delegation.md) | Accepted | — |
| [0032: A loopback browser may own phone media](0032-loopback-browser-media-frontend.md) | Partially superseded | [0033](0033-client-owned-native-media.md) makes both clients media owners; [0034](0034-authenticated-client-network.md) adds authenticated network transport. |
| [0033: All call clients own audio and WebRTC](0033-client-owned-native-media.md) | Accepted | — |
| [0034: Authenticated WSS transports the same client API](0034-authenticated-client-network.md) | Accepted | — |
| [0037: Native descendant navigation through TUI attachment](0037-descendant-tui-attachment.md) | Accepted | — |
| [0038: Thread mailbox wake-ups](0038-thread-mailbox-wakeups.md) | Recorded | — |
| [0039: Project memory is part of the default role](0039-project-memory-in-default-role.md) | Accepted | — |

## Identifier history

Corrected 2026-09-08. Each old filename below identifies one specific record;
the old number alone was ambiguous. Existing record bodies were retained, with
updated references and explicit status annotations. Do not reuse retired
identifiers for unrelated decisions or renumber the rest of the log.

| Former file | Current record |
|---|---|
| `0024-descendant-tui-attachment.md` | [0037](0037-descendant-tui-attachment.md) |
| `0026-thread-mailbox-wakeups.md` | [0038](0038-thread-mailbox-wakeups.md) |
| `0033-project-memory-in-default-role.md` | [0039](0039-project-memory-in-default-role.md) |

Identifiers 0035 and 0036 are reserved by the concurrent native-Android and
desktop-attachment work; this repair starts after those observed reservations.

New records take an unused identifier above the highest current number. Check
the landing branch before assigning it and coordinate shared ADR edits. Cite
complete relative file links; a title change must not redirect a citation to a
different decision. Keep this navigation index and the record's status together.
