# 0009: One foreground app, one workspace per launch

Status review 2026-09-08: partially superseded.
[0015](0015-retain-controller-replace-runtime.md) replaces the single process, [0020](0020-native-launch-defaults.md) replaces launch defaults, [0024](0024-server-and-pointer-frontend.md) replaces foreground-only ownership, and [0033](0033-client-owned-native-media.md) moves media to clients. Exact native identity and explicit continuation remain.

**Historical policies:** [ADR 0015](0015-retain-controller-replace-runtime.md) supersedes the single-process topology. [ADR 0020](0020-native-launch-defaults.md) makes ordinary launch fresh and full access optional; explicit continuation and ownership checks remain.

Accepted 2026-09-04; consolidated 2026-09-05. Supersedes the topology in ADRs [0002](0002-remote-console-attaches-to-client.md), [0003](0003-remote-console-crosses-machines-over-the-tailnet.md), [0004](0004-a-resident-server-owns-the-coordination-runtime.md) and [0005](0005-pair-once-and-race-authenticated-routes.md). Former worker/account provisions are retired; their history is in Git.

AgentVoice runs TUI, audio, WebRTC and coordination in one foreground process,
owning an unmodified Codex app-server child over stdio. Quit stops app-owned work
and closes the child; native history remains resumable. There is no resident,
remote frontend, custom worker/report pipeline or account-balancing wrapper.

One canonical existing workspace defaults to launch cwd (CLI beats explicit file
workspace). Continue selects the newest eligible unarchived AgentVoice main thread
in that exact directory; explicit resume must match that inventory. Errors never
silently become Fresh. This is selection, not memory or filesystem isolation.
Per-thread locks prevent simultaneous AgentVoice owners; old main threads keep
locks until quit because native work can remain active after Fresh. Fresh cuts
media before switching identity, without copying transcripts or moving work.

Every launch requires --allow-full-access and native permission confirmation;
unexpected human input is refused visibly. CODEX_HOME is inherited unchanged:
Codex owns authentication, configuration, skills and history. AgentVoice settings
and explicit prompt contents load once at launch, reused on redial and Fresh.
Prompt paths resolve beside the chosen config; raw fields retain precedence.
Ordered native startup -c entries apply to the child, with file entries before CLI
entries. No automatic prompt activation, injected skills or global config writes.

Native readiness checks run before audio opens, and negotiation follows audio
readiness. This can create/resume a native conversation before a device-open
failure, but avoids microphone capture when prompts, permissions, history or Fast
are invalid. Media errors are visible without debug; detailed tracing is opt-in.
M/S toggle mute and Space/pointer PTT only hold; voice-name hot reload and tap/hold
classification were removed to give settings and controls one consistent rule.

Existing legacy state, profiles, credentials and services are never migrated or
removed automatically. Installation and live voice validation are separate scope.
