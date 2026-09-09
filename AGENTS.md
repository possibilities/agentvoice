# agentvoice — repository guidance

A local Codex voice server with a pointer-only TUI and same-device phone browser.
`agentvoice server`
waits on a private workspace socket without opening audio or Codex; `agentvoice client`
connects and starts a call. Bare `agentvoice` composes that client, voice transcript,
and stock agent attachment in one foreground smolmux process with local PTYs only.
`agentvoice phone` serves one capability-bearing loopback page; its browser owns
audio and WebRTC while Termux retains the controller and Codex child.
The server-owned call controller retains exact thread
identity, leases, operation journal and control/event transports; its disposable runtime
owns config/prompt/role loading and an owned stock Codex app-server. All clients
own audio and WebRTC; no production server path loads native media ([ADR 0033](docs/adr/0033-client-owned-native-media.md)).
Frontend disconnect closes the call before another can begin. The macOS installer supervises the waiting default server as a user LaunchAgent.
Authenticated WSS client API v2 is opt-in behind a dedicated tailnet-only TLS
proxy ([ADR 0034](docs/adr/0034-authenticated-client-network.md)). `client` and `phone --connect` load a private device grant;
browser content stays loopback-only and never receives that grant. Never expose
native Codex, MCP, attachment or event sockets through this gateway. Read [README.md](README.md), [CONTEXT.md](CONTEXT.md), the [decision index](docs/adr/README.md) and ADRs [0033](docs/adr/0033-client-owned-native-media.md)/[0032](docs/adr/0032-loopback-browser-media-frontend.md)/[0024](docs/adr/0024-server-and-pointer-frontend.md)/[0022](docs/adr/0022-websocket-native-tui.md) for the active topologies; ADRs [0015](docs/adr/0015-retain-controller-replace-runtime.md)/[0016](docs/adr/0016-restart-handoff.md) describe retained MCP/API
runtime replacement and restart handoff semantics.

## What vanilla Codex means

The baseline includes both the Codex client and server. Read
[native defaults](docs/native-defaults.md#what-vanilla-codex-means) before changing
settings or prompts; a server omission default alone does not establish client
parity. New departures need a product decision or operator configuration.

## Android collaboration

The operator's current worktree roles are:

- `silver-forest-a21f` is the Halo/Persona specialist: Rive assets and decoding,
  animation behavior, Contained motion/colors, renderer tests, licensing/provenance
  research and Persona visual review.
- `green-river-71c3` owns the native app and Design studio: primary app/integration
  code, controls and saved profiles, attribution/docs integration, builds, tests
  and delivery, plus ADB/device, Android VM, scrcpy and live studio operations.

Green-river collaborates closely with silver-forest on Persona-specific changes
and owns their integration and delivery. Coordinate file ownership before
overlapping edits in a shared checkout; keep device and host operations with
green-river.

New studio requests append after the current work unless the operator explicitly
cancels or reorders it. Keep every requested design idea in the follow-up queue;
finish verification and delivery before starting the next round. The physical
phone is the current preview; the operator explicitly destroyed the emulator.

## Commands

- `bun run test` — tests in tests/, fake protocol/media, no credentials or mic.
  Do not run bare `bun test`: it can discover dependency/vendor tests.
- `bun run typecheck` — strict TypeScript, no emit.
- `bun run lint` / `bun run format` — Biome checks / fixes.
- `bun run server` — waiting foreground server. Calls need Codex login; terminal
  calls also need built native audio, while phone calls do not load it.
- `bun run console` — independent pointer frontend; connects to the workspace server.
- `bun run native:build` / `bun run audio:probe` — build / exercise audio.
  The latter opens hardware; never substitute it for a no-microphone UI test.
- `bun run android:build` — cross-compile the ARM64 Android/Termux standalone
  executable at `dist/agentvoice-android-arm64`. It neither installs to a device
  nor opens media/inference; phone calls do not require the native audio build.
- `bun run android:configure --device <adb-serial>` — host browser controls for
  the debug APK's synthetic native preview. Read the
  [studio contract](android/configurator/README.md) before changing preview UI,
  profiles, gestures, reconnect or rendering. Preserve current operator choices
  and saved bytes; explicit Save stores a profile, never production defaults.
  Landing studio code does not adopt an experimental design into production.
  No audio, grants, voice calls or automatic edit/Save replay. Keep the physical
  phone preview and renderer instance stable; do not recreate the destroyed VM.
- `scripts/install-android --install --host <ssh-target>` — explicitly build and
  atomically converge that standalone on an already prepared Termux phone. It is
  never part of the desktop installer or an unattended update and starts no call.
- `bun run app-server:probe` — initialize and workspace-filtered list against
  an owned stock child, no turns/audio. Verify before Codex runtime upgrades.
- `bun run generate:schema` — regenerate server.schema.json after schema edits.
- `bun run generate:events-schema` — regenerate the repo-local events.schema.json
  contract and named event catalog; keep its drift and socket-frame tests passing.
- `scripts/install.sh --install` / `bun run cli:install` — same editable command and macOS LaunchAgent
  installer, called by AgentStart. Requires explicit installation scope;
  never use the live destination to test. Installer tests use disposable checkouts,
  local-only dependencies, a fake compiler, a fake launchctl runner and a Codex invocation sentinel.
  Use --command-only for command publication fixtures; never run live launchctl in tests.

## Source map

Read [architecture and source ownership](docs/architecture.md) before editing a
subsystem. It includes the recording and attachment lifecycle.

## Ownership and state invariants

Public voice launches support native/configured permissions without a flag.
Top-level allow-full-access:true in server.json is equivalent to the full-access
CLI flag; top-level debug:true enables runtime debug logs. Both default false,
and CLI opt-ins win over false in the file. Resolve once per runtime generation.
--allow-full-access explicitly requests danger-full-access/never; it wins over
conflicting permission selectors, not unrelated settings. Do not reject launch,
resume or settings reports solely because permissions are restricted or
unreported. Preserve native managed requirements. Command/file/permission approvals,
tool questions and MCP elicitations flow through an attached stock TUI. The server
terminal shows an interaction notice; without a TUI, native Codex retains the request and
replays it on attachment. Never add automatic consent, refusals that race the TUI,
invented answers or an AgentVoice approval queue. Unsupported client tools/auth/
legacy/unknown requests are still refused visibly. See ADRs [0020](docs/adr/0020-native-launch-defaults.md)/[0022](docs/adr/0022-websocket-native-tui.md).

Resolve one existing absolute real workspace before spawning the child:
CLI workspace > explicit file workspace > current managed default generation. Use it for lookup,
thread start/resume; relative runtime roots use it too. Reject
conflicting cwd and identity escape hatches. This is selection, not filesystem
sandboxing or memory isolation.

Ordinary launch creates a new conversation without resume-selection history
lookup. Explicit --continue uses native unarchived history, newest updated first, with
sourceKinds appServer plus vscode, all providers and exact cwd. Stock 0.153.3
classifies this third-party app-server client as vscode and can omit threadSource
from list rows, so verify candidate ownership with thread/read before selecting
agentvoice-orchestrator, no-parent, non-ephemeral history. Explicit resume must
be found in that inventory. Do not hide lookup/resume failures as Fresh.

Each frontend connection starts one call using the server's conversation selection
flags. Explicit workspaces are pinned at server launch; otherwise the default
server resolves the current generation at call start. Every call pins its canonical
workspace through runtime replacements. The default frontend socket stays stable
across generations; explicit CLI workspaces use their own hashed sockets. Close its frontend to end audio,
app-owned work and the Codex child; native history remains untouched. The server
waits for complete teardown before accepting another call. MCP/API runtime restart
retains the frontend, exact thread leases and controller endpoints while replacing
the runtime. Leases last until call shutdown. A cleanup failure prevents subsequent
calls until server termination.
Other workspace servers may run independently; other clients do not honor this guard.

App state: default/workspaces/ generations, default/service/ logs, frontend/ sockets,
thread-locks/ and opt-in unique runs/ logs under
~/.local/state/agentvoice ($XDG_STATE_HOME honored). Configuration/prompt paths
remain ~/.config/agentvoice/server.json and convention prompt files beside it. Inherit
CODEX_HOME unchanged (including omission); native Codex owns authentication,
credential storage/refresh, configuration and history. Never discover, create or
reconcile profile homes, read auth.json, invoke account tools/login, or replace
the child on quota events. Existing profile directories/links stay untouched.
Retired accounts configuration errors even if false/empty; no automatic migration.

Live controllers also own atomic mode-0600 transport descriptors below the
mode-0700 control directory. They may contain the bearer capability for the
explicit `agentvoice mcp-config` export and local `attach` bootstrap, are removed on normal close, and must be
selected through a bounded live UDS status check by exact canonical workspace
and optional thread. Never put the token in status or diagnostics, trust mutable
identity from the descriptor, choose the newest ambiguous controller, or clean
up an unowned stale record while reading.

Do not silently install, restart/uninstall old services, change global config,
edit archive checkouts or start inference/audio probes. Those require scope.

## Upstream realtime semantics

Read [native defaults and realtime semantics](docs/native-defaults.md) before
changing session lifecycle, native launch settings, prompts, roles or Codex
versions. Preserve its stop attribution, renewal, transport and override rules;
the [field guide](docs/field-guide.md) retains the underlying audit evidence.


## Conventions

- Keep one root AGENTS.md as the entrypoint. Detailed constraints belong in the
  linked owners above, with explicit reading triggers here.
- Comments state constraints the code cannot show, not narration.
- Record<string, unknown> access uses bracket keys.
- The TUI is pointer-only: two full-height monochrome channel buttons, with
  a bottom push-to-talk button while the mic is muted. Keep existing text labels,
  grey out muted channels, show only connection phase above them. No keybindings,
  modal, animation, meters or additional status. Signals/terminal close end a call.
- Apply the [configuration and prompt rules](docs/native-defaults.md#configuration-and-prompt-rules)
  before changing any native settings, role or prompt path.
- No AgentVoice worker execution tools, registry, archival or result reports.
  Custom turn submission is limited to explicit MCP/API restart handoffs ([ADR 0016](docs/adr/0016-restart-handoff.md)) and immediate metadata-mailbox tally wake-ups ([ADR 0038](docs/adr/0038-thread-mailbox-wakeups.md)). For handoffs, submit once
  after exact identity and live media checks; never retry ambiguous acceptance,
  echo the private prompt in status/errors or change prompt defaults.
  Native Codex tools, subagents and voice handoffs stay native.
  Retired dispatch/dispatch-reports config keys error, including explicit false.
  Saved custom tool calls receive an immediate failed tool result and visible
  retirement notice; never resurrect a handler or rewrite native history.
  Raw dynamicTools metadata passes on start only, with a visible warning and no
  client implementation. Unsupported client handoffs and media overrides also warn.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script.
  Skill names and descriptions provide capability discovery; do not add a
  second tool catalog to prompts. See `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.


## Voice recording and attachment

Read the [recording and attachment contract](docs/architecture.md#voice-recording-and-attachment)
before changing writers, discovery, attachment or the signed media runtime.
