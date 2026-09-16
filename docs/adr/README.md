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
| [0014: Roles are directories delivered to the owned child](0014-roles.md) | Partially superseded | [0042](0042-workspace-role-databases.md) captures explicitly ejected workspace roles in SQLite; unbound roles retain directory behavior. |
| [0015: Retain the foreground controller, replace the voice runtime](0015-retain-controller-replace-runtime.md) | Partially superseded | [0024](0024-server-and-pointer-frontend.md) moves the retained controller/runtime under the waiting server; [0033](0033-client-owned-native-media.md) moves native media to clients. Runtime replacement, owned Codex cleanup and journaled operations remain. |
| [0016: Submit an optional handoff after runtime restart](0016-restart-handoff.md) | Accepted | — |
| [0017: Remove automatic spoken-history replay](0017-remove-spoken-history-replay.md) | Partially superseded | [0074](0074-fail-closed-voice-history.md) removes unsafe automatic context again; retired keys remain retired. |
| [0018: Observe lifecycle state through a separate Unix socket](0018-read-only-lifecycle-event-socket.md) | Partially superseded | [0026](0026-persistent-voice-transcripts.md) adds a separate persistent voice-transcript writer. The live event feed remains transient, lifecycle snapshots remain content-free, and their watermarks do not promise transcript replay. |
| [0019: Compare defaults against the Codex client and server together](0019-client-server-default-baseline.md) | Recorded | — |
| [0020: Native permissions and context, fresh ordinary launches](0020-native-launch-defaults.md) | Partially superseded | [0029](0029-desktop-startup-context.md) replaces the startup-context default; [0052](0052-workspace-session-marker.md) replaces fresh launches and selection flags. |
| [0021: Attach a stock TUI through a guarded local gateway](0021-guarded-tui-attachment.md) | Superseded | [0022](0022-websocket-native-tui.md) replaced its transport; [0072](0072-retire-terminal-composition-and-attachments.md) removes stock TUI attachment and retains only a narrower host gateway. |
| [0022: WebSocket-only RPC and native TUI interaction](0022-websocket-native-tui.md) | Partially superseded | [0072](0072-retire-terminal-composition-and-attachments.md) removes native TUI interaction, prompt answers and broad RPC; private WebSocket transport remains. |
| [0023: Conversation observation for independent UIs](0023-conversation-observation.md) | Recorded | — |
| [0024: Waiting local server and pointer-only frontend](0024-server-and-pointer-frontend.md) | Partially superseded | [0025](0025-launchagent-default-workspaces.md) supplies the default service/workspace lifecycle, [0033](0033-client-owned-native-media.md) moves audio/WebRTC to clients, [0053](0053-retain-workspace-session-across-frontend-detach.md) retains the workspace session across frontend detach, and [0071](0071-restore-marked-session-on-server-start.md) restores marked sessions before a frontend. The waiting server and pointer frontend remain. |
| [0025: LaunchAgent and default workspace generations](0025-launchagent-default-workspaces.md) | Partially superseded | [0053](0053-retain-workspace-session-across-frontend-detach.md) pins the selected default generation for the server lifetime; [0071](0071-restore-marked-session-on-server-start.md) selects a marked generation at server launch. |
| [0026: Persistent workspace voice transcripts](0026-persistent-voice-transcripts.md) | Partially superseded | [0072](0072-retire-terminal-composition-and-attachments.md) removes the terminal viewer; persistent recording and bounded web reading remain. |
| [0027: A microphone identity for the LaunchAgent](0027-service-microphone-identity.md) | Partially superseded | [0033](0033-client-owned-native-media.md) moves microphone use to the client. The installer-owned signed runtime, stable permission identity and operator-owned consent remain.
| [0028: Bare command composes local terminal apps](0028-foreground-composition.md) | Superseded | [0072](0072-retire-terminal-composition-and-attachments.md) makes bare invocation show help and removes terminal composition. |
| [0029: Desktop startup-context default](0029-desktop-startup-context.md) | Recorded | — |
| [0030: Conversation-first delegation through native operator configuration](0030-conversation-first-delegation.md) | Superseded for configuration ownership | [0031](0031-role-owned-delegation.md) moves delegation mode to the selected role. |
| [0031: The selected role owns its native delegation mode](0031-role-owned-delegation.md) | Partially superseded | [0043](0043-adaptive-conversation-first-delegation.md) replaces mandatory read-only/thinking delegation; role ownership remains. |
| [0032: A loopback browser may own phone media](0032-loopback-browser-media-frontend.md) | Partially superseded | [0033](0033-client-owned-native-media.md) makes both clients media owners; [0034](0034-authenticated-client-network.md) adds authenticated network transport; [0053](0053-retain-workspace-session-across-frontend-detach.md) replaces page-loss teardown of the backend session. |
| [0033: All call clients own audio and WebRTC](0033-client-owned-native-media.md) | Partially superseded | [0053](0053-retain-workspace-session-across-frontend-detach.md) makes frontend ownership disposable while retaining the backend workspace session. Client media ownership remains. |
| [0034: Authenticated WSS transports the same client API](0034-authenticated-client-network.md) | Partially superseded | [0053](0053-retain-workspace-session-across-frontend-detach.md) replaces network-loss teardown of the backend workspace session; authentication and transport boundaries remain. |
| [0035: A native Android client is one voice instrument](0035-native-android-voice-client.md) | Implemented | Preview tuning continues in [0041](0041-host-persona-configurator.md). |
| [0036: Desktop attachment to a mobile-owned call](0036-desktop-mobile-attachment.md) | Superseded | [0072](0072-retire-terminal-composition-and-attachments.md) removes the desktop attachment view and SSH bridge. |
| [0037: Native descendant navigation through TUI attachment](0037-descendant-tui-attachment.md) | Superseded | [0072](0072-retire-terminal-composition-and-attachments.md) removes TUI attachment and descendant navigation. |
| [0038: Thread mailbox wake-ups](0038-thread-mailbox-wakeups.md) | Superseded | [0080](0080-direct-child-completion-delivery.md) removes the mailbox/opening protocol and replaces count-only notices with one bounded completion output per direct-child terminal turn. |
| [0039: Project memory is part of the default role](0039-project-memory-in-default-role.md) | Accepted | — |
| [0040: The default role guides deliberate subagent routing](0040-deliberate-subagent-routing.md) | Partially superseded | [0043](0043-adaptive-conversation-first-delegation.md) changes when to delegate; [0048](0048-universal-working-doctrine.md) moves dated model tables to reference material and retains assignment/capability boundaries. |
| [0041: Configure the native phone preview from a host browser](0041-host-persona-configurator.md) | Accepted | Studio profiles remain exploratory; landing code does not select production defaults. |
| [0042: Workspace-owned role snapshots and explicit voice application](0042-workspace-role-databases.md) | Accepted, first slice implemented | Explicit ejection and voice changes; broader editing and automatic ejection remain follow-up work. |
| [0043: Adapt delegation to the conversation and the work](0043-adaptive-conversation-first-delegation.md) | Partially superseded | [0047](0047-adaptive-work-execution.md) extends adaptive execution to implementation and edits; useful parallelism, explicit handoffs and direct call controls remain. |
| [0044: A native macOS menu app observes the waiting server](0044-native-macos-menu-app.md) | Extended | [0065](0065-native-menu-server-lifecycle.md) adds explicit server lifecycle actions; the AppKit login item stays independent from LaunchAgent and call lifetime. |
| [0045: Pair phone begins as a persistent native interaction preview](0045-native-pair-phone-preview.md) | Partially superseded | [0046](0046-durable-device-pairing.md) replaces the inert QR; the persistent window lifecycle remains. |
| [0046: Pair phones with durable device keys](0046-durable-device-pairing.md) | Accepted | One-use enrollment, non-expiring device identity, signed WSS upgrades, and legacy-grant coexistence. |
| [0047: Adapt work execution to the human's current intent](0047-adaptive-work-execution.md) | Accepted | Direct or delegated work by task and interaction needs; presentation follows supplied session context and human preferences. |
| [0048: One working doctrine with explicit runtime boundaries](0048-universal-working-doctrine.md) | Accepted | Broad outcome ownership, proportional execution and verification, conditional completion semantics, and silence-only hold/mute in both agents. |
| [0049: Add a worker role with bounded assignment ownership](0049-worker-role.md) | Accepted | Existing default remains manager; one explicit worker role, parent-or-human return ownership, useful bounded delegation, and runtime-qualified completion. |
| [0050: Correlate native TUI hook trust to its current inventory](0050-correlated-native-hook-trust.md) | Superseded | [0072](0072-retire-terminal-composition-and-attachments.md) removes attachment settings and hook-trust writes. |

| [0051: AgentStart owns manager and worker roles](0051-agentstart-owns-working-roles.md) | Accepted | Supersedes 0049's source ownership and default name. |
| [0052: Persist one current session in each workspace](0052-workspace-session-marker.md) | Partially superseded | Exact marker-based resume and explicit API/MCP new session remain. [0053](0053-retain-workspace-session-across-frontend-detach.md) replaces frontend-scoped call lifetime and lease release; [0072](0072-retire-terminal-composition-and-attachments.md) removes terminal pane reopening. |
| [0053: Retain one workspace session across frontend detach](0053-retain-workspace-session-across-frontend-detach.md) | Partially superseded | [0071](0071-restore-marked-session-on-server-start.md) replaces first-frontend lazy start for marked workspaces; one server-lifetime controller/runtime, disposable media attachments, and explicit replacement/shutdown boundaries remain. |

| [0054: Discover native voices and persist one random choice](0054-native-voice-discovery.md) | Accepted | Dedicated native-backed voice inspection, pre-save compatibility validation, and durable random selection; refines [0042](0042-workspace-role-databases.md). |
| [0055: One durable Work owner with an independent HUD](0055-durable-work-hud.md) | Partially superseded | [0056](0056-independent-agenthud.md) transfers source and delivery to independent AgentHUD; native execution remains native. |

| [0056: Transfer durable Work and HUD into independent AgentHUD](0056-independent-agenthud.md) | Accepted | Independent source owner, versioned native observation boundary and managed HUD service. |
| [0057: Responsive web transcripts with correlated submissions](0057-responsive-web-transcripts.md) | Accepted | Windowed rendering, stable disclosures and exact native identity reconcile immediate local submissions. |
| [0058: Durable web composer drafts and reader recovery](0058-durable-web-composer-and-reader-recovery.md) | Accepted | Same-call history survives recoverable reader failures; browser entry recovery is separate from native delivery. |
| [0059: Clarify mailbox and conversation-hold guidance](0059-clarify-mailbox-and-conversation-hold-guidance.md) | Partially superseded | [0080](0080-direct-child-completion-delivery.md) removes its mailbox behavior; the conversational-hold conclusion remains. |
| [0061: Own Android call notification control contrast](0061-custom-android-call-notification.md) | Accepted | Custom expanded controls replace CallStyle; microphone service and communication audio ownership remain unchanged. |
| [0062: Web text interaction without voice attachment](0062-web-text-interaction-without-voice-attachment.md) | Accepted | Verified retained native session reachability grants text authority independently of media attachment. |
| [0063: Linked Markdown document viewer](0063-linked-markdown-document-viewer.md) | Partially superseded | [0075](0075-own-web-transcript-ui.md) transfers source ownership to AgentVoice; host-authorized linked Markdown access and contained relative navigation remain. |

| [0060: Web session and browser-process continuity](0060-web-session-and-browser-process-continuity.md) | Partially superseded | [0071](0071-restore-marked-session-on-server-start.md) limits its empty-server state to unmarked workspaces; browser recovery and served-code activation remain. |

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

Identifiers 0035 and 0036 were reserved by the concurrent native-Android and
desktop-attachment work and are now listed above. When that branch landed, its
`0037-host-persona-configurator.md` was assigned 0041 to preserve this branch's
already-landed 0037 descendant-attachment record; references were updated.

New records take an unused identifier above the highest current number. Check
the landing branch before assigning it and coordinate shared ADR edits. Cite
complete relative file links; a title change must not redirect a citation to a
different decision. Keep this navigation index and the record's status together.

- [0064: Browser presentation preferences](0064-browser-presentation-preferences.md)

- [0065: Explicit server lifecycle controls in the native menu](0065-native-menu-server-lifecycle.md)

- [0066: Restore bounded same-thread voice context](0066-same-thread-voice-continuity.md)

- [0067: Trial continuous muted Android input](0067-android-muted-input-continuity-trial.md) — accepted after the human-run muted worker-completion trial.

- [0068: Export durable native parentage from persisted history](0068-durable-native-parentage-export.md) — accepted; version 2 native metadata keeps ancestry separate from semantic Work and exact receiving turns.

- [0069: Observe directory role content by runtime generation](0069-directory-role-content-status.md) — accepted; additive content status preserves directory skill and database revision semantics.

- [0070: Preserve menu presence during app-only updates](0070-installer-owned-menu-presence.md) — accepted; explicit private graceful quit and conditional relaunch keep menu updates independent from server restart.

- [0071: Restore a marked workspace session at server start](0071-restore-marked-session-on-server-start.md) — accepted; saved native work and web history return without reserving media or waiting for a client.

- [0072: Retire terminal composition and attachment commands](0072-retire-terminal-composition-and-attachments.md) — accepted; bare invocation shows help, the web UI owns transcripts and typed input, and the host gateway is narrowed to exact-root input and explicit speech.

- [0073: Parallel workspace web readers](0073-parallel-workspace-web-readers.md) — accepted; explicit host-side workspace and local origin selection keep test sessions independent from the default server.

- [0074: Keep historical speech outside realtime input](0074-fail-closed-voice-history.md)

- [0075: Own the web transcript UI in AgentVoice](0075-own-web-transcript-ui.md) — accepted; source, dependencies, scoped styles, and regressions live inside AgentVoice without an AgentChats package or archive.

- [0076: Replace media clients through server-owned admission](0076-media-client-takeover.md) — accepted; terminal takeover is automatic, Android requires a fenced confirmation, and native work remains in the same retained session.

- [0077: Preserve bounded transcript content summaries](0077-bounded-transcript-content-summaries.md) — accepted; oversized tools keep identity, real status, actionable failures, size metadata, and a safe excerpt without raising transport bounds.

- [0078: Composer local file references remain editable text](0078-composer-local-file-references.md) — accepted; bounded host metadata picker and path-aware drop/paste insert ordinary absolute `@path` text without upload transport.

- [0079: Clipboard images use native local-image input](0079-composer-native-local-images.md) — accepted; retained private local files, numbered image attachments and native localImage parts preserve Codex image semantics.
- [0080: Deliver each direct-child completion immediately](0080-direct-child-completion-delivery.md) — accepted; one bounded native tool output replaces mailbox notices, openings, replay and persistence.
- [0081: Saved Android server profiles](0081-saved-android-server-profiles.md) — accepted; encrypted migration, explicit switching and workspace-targeted terminal pairing retain independent server access.
- [0082: Let the kernel release service-operation locks](0082-kernel-owned-service-operation-lock.md) — accepted; crash-released flock ownership prevents interrupted lifecycle commands from stranding menu and CLI actions.
- [0083: Adopt directory role contents as a fenced workspace revision](0083-adopt-directory-role-revisions.md) — accepted; explicit validated capture preserves the workspace role identity and saved settings while advancing desired content without live activation.
