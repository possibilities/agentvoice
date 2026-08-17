# agentvoice — repository guidance

Minimal voice system for Codex: one voice console attached to a
launchd-resident `codex app-server` over a private unix socket. Read
`README.md` for usage, `CONTEXT.md` for the glossary — use its canonical
terms in code, comments, and commit messages.

## Commands

- `bun test` — unit tests (pure logic only; no codex or audio needed)
- `bun run typecheck` — `tsc --noEmit`, strict with `noUncheckedIndexedAccess`
- `bun run lint` / `bun run format` — Biome check / autofix
- `bun run console` — the real thing (needs the resident installed:
  `agentvoice resident install`, codex ≥ 0.147 logged in, a built duplex
  device, and a microphone)
- `bun run native:build` / `bun run audio:probe` — build and exercise the
  duplex audio device (needs Zig or a C11 compiler; the probe needs audio
  hardware). `bun run setup` builds it; the console will not start without it
- `bun run resident:probe` — live verification of the resident-transport
  semantics (spawns its own app-server on a scratch socket; spends a few tiny
  turns and seconds of realtime session). Re-run before bumping the supported
  codex version
- `bun run accounts:probe` — live verification of account-profile mechanics

## Map

One program, three layers. `src/` root holds the entry and shared utilities;
everything else belongs to exactly one layer.

- `src/main.ts` — CLI entry: the bare command is the console; `resident`,
  `accounts`, and `remote` are subcommands
- `src/paths.ts` — XDG path resolution: state files, the resident socket,
  the config location
- `src/core/` — the coordination layer (attached to the resident, no UI):
  - `config-schema.ts` — the `server.json` surface as a zod schema, the
    single source of truth: `config.ts` validates files with it, and
    `scripts/generate-schema.ts` generates `server.schema.json` from it.
    Every field is `.optional()` with no zod `.default()` so unset stays unset
  - `config.ts` — config resolution (CLI > `server.json` > default); unset
    options are not sent to codex at all. Values nest under `orchestrator` and
    `voice` by which agent they prime, not by which RPC carries them. Also owns
    prompt-file discovery (`PROMPT_FILES`)
  - `params.ts` — pure config+prompts → `thread/start`, `thread/resume`, and
    `thread/realtime/start` payloads; tested in `tests/params.test.ts`
  - `ws-frame.ts` — pure RFC 6455 client codec for the resident's socket
    transport; tested in `tests/ws-frame.test.ts`
  - `attach.ts` — the attachment: JSON-RPC over WebSocket framing over the
    resident's unix socket; request/notify, notification fan-out, fail-closed
    denial of approval requests (an optional `onRequest` answerer may claim a
    request first; everything else denies)
  - `session.ts` — the voice-session state machine (supersede, attribution);
    pure effects-injected logic, tested in `tests/session.test.ts`
  - `workers.ts` — worker dispatch under `orchestrator.dispatch`: the three
    dynamic tools, the worker registry, worker-report composition, and
    restart adoption (`adopt`/`persistenceRecords`); pure effects-injected
    logic, tested in `tests/workers.test.ts`
  - `accounts.ts` — account profiles and balanced selection under
    `accounts.balance`: identity/balancer-output parsing (pure), the symlink
    farm, selection with canonical fallback; tested in
    `tests/accounts.test.ts`, upstream mechanics re-verified by
    `scripts/account-profiles-probe.ts`
  - `runtime.ts` — wiring: the attachment lifecycle (reattach with backoff;
    the resident process itself is launchd's job), the persisted orchestrator
    thread (resume on attach, `fresh` to abandon), stranded-turn interruption
    and worker reconciliation on attach, rotation via `launchctl kickstart`
    at idle
- `src/console/` — the surface: `transport.ts` (werift WebRTC peer, two-peer
  redial, driven by runtime events), `duplex-audio.ts` + `duplex-device.ts` +
  `native/` (the duplex audio device — the only audio path), `dsp.ts` (pure
  audio math, tested), `tui.ts` (the one OpenTUI instrument shared by both
  modes), `ui.ts` (the Console host), `remote-ui.ts` (the Remote-console host),
  and the remaining `remote-*` files (their owner-only IPC)
- `src/resident/` — the resident bundle: `contract.ts` (spawn contract,
  socket, account state file), `install.ts` (wrapper + LaunchAgent rendering,
  install/status/restart/uninstall, and the wrapper's per-spawn `pick-home`)
- `server.schema.json` — the whole config surface, every key typed and
  documented; generated from the zod schema in `src/core/config-schema.ts`
  by `bun run generate:schema` (a test fails on drift, and the generator
  throws on an undocumented key). `server.json.example` must stay a
  verbatim-copy no-op; a test asserts that. Adding a config key means
  declaring and describing it in `config-schema.ts` — the loader and the
  published schema both follow, and the drift gate enforces regeneration.

**One `AGENTS.md`, at the root.** Codex loads only the chain from the project
root down to the thread's cwd and never descends into subdirectories
(`codex-rs/core/src/agents_md.rs`; confirmed on 0.147 with a two-level probe).
pi is the same shape from the other direction: at startup it walks from cwd up
through every ancestor, taking one guidance file per directory — `AGENTS.md`
before `CLAUDE.md` — and never descends either
(`@earendil-works/pi-coding-agent` 0.84.1, `dist/core/resource-loader.js`,
`loadProjectContextFiles`). Since both run here with cwd at the repo root, a
`src/core/AGENTS.md` would be read *never* — it would rot unnoticed. Only
Claude Code loads a subtree `CLAUDE.md` on demand when it reads files there.

## Upstream realtime semantics (verified against codex 0.147 source + probes)

These invariants are load-bearing for `session.ts`; re-verify them before
bumping the supported codex version (`codex-rs/core/src/realtime_conversation.rs`,
`codex-rs/app-server/src/request_processors/turn_processor.rs`):

1. Three gates make the realtime surface work at all: spawn with
   `--enable realtime_conversation`, declare `experimentalApi: true` in
   `initialize`, and pass an explicit webrtc transport to
   `thread/realtime/start`.
2. app-server manages **one** realtime session per thread. A new start
   **supersedes** the previous session silently — no `closed` notification is
   emitted for it (renewal therefore never sends a stop).
3. `thread/realtime/stop` takes only `threadId` and always emits **exactly
   one** `closed(reason:"requested")`, even when no session exists. Ops on a
   thread are processed serially, so a stop issued after a start always lands
   after it.
4. `started` echoes the `realtimeSessionId` we chose; `closed` and `error`
   carry no session id. Natural end is `closed("transport_closed")`; failures
   emit `error` and then `closed("error")`.
5. A superseded session's WebRTC media path is not torn down promptly — the
   old peer lingers with a dead control plane. Clients must close it themselves
   (the console does, when the successor connects).
6. Priming is split across both calls, and not along agent lines. The
   orchestrator agent takes `baseInstructions` / `developerInstructions` on
   `thread/start`; the voice agent takes `prompt` on `thread/realtime/start`.
   But `realtimeStartInstructions` / `realtimeEndInstructions` also ride on the
   realtime call while being developer messages to the *orchestrator* — and
   they are therefore re-sent on every redial.
7. `prompt` is a double-option upstream: omitted keeps codex's built-in
   `backend_prompt.md`, while both `null` and `""` yield an empty prompt
   (`codex-rs/core/src/realtime_prompt.rs`). Prompt files encode that as
   absent vs. present-but-empty. A non-empty
   `experimental_realtime_ws_backend_prompt` in `~/.codex/config.toml` silently
   outranks the request `prompt`, and we cannot see it.
8. Thread and realtime params are serde-lenient: unknown fields are ignored,
   never rejected. A misspelled key in an `extra:` block fails silently, and
   `thread/resume` quietly drops the 12 start-only fields rather than erroring
   — hence `params.ts` filters them itself.
9. `initialItems` is realtime v3 only, capped at 128 items and 8,192 estimated
   text tokens. This is why `voice.version` defaults to v3 rather than
   deferring to codex config.
10. The webrtc transport is load-bearing for auth, not just media: the
    websocket transport hard-requires an API key (`realtime_api_key`,
    `realtime_conversation.rs`), while webrtc authorizes the SDP POST and the
    sideband WebSocket with the ModelClient's ordinary bearer — which is what
    makes a ChatGPT login work here at all. The call URL derives from the
    session's model provider (`client.rs`, `REALTIME_CALLS_ENDPOINT`), so any
    provider-swapping wrapper (e.g. a localhost credential proxy) silently
    breaks realtime even when threads still work.
11. ChatGPT refresh tokens rotate with server-side reuse detection
    (`login/src/auth/manager.rs`, `refresh_token_reused`): exactly one party
    may ever refresh a grant. Account profiles therefore hold their own
    grant's `auth.json` and codex alone refreshes it — never copy credentials
    between stores. Cross-profile resume and grant coexistence are re-verified
    by `bun run accounts:probe`.

## Resident-transport semantics (verified by `bun run resident:probe` on 0.147)

These invariants are load-bearing for `attach.ts` and `runtime.ts`
(`codex-rs/app-server-transport/src/transport/unix_socket.rs`,
`codex-rs/app-server/src/lib.rs`, `request_processors/thread_processor.rs`):

12. `--listen unix://PATH` serves a **WebSocket handshake over the unix
    stream** (tokio-tungstenite `accept_async`) — hence the hand-rolled
    client codec in `ws-frame.ts`; Bun's native WebSocket cannot dial unix
    sockets. The socket is created 0600 and upstream requires a private
    (0700, owned) parent directory; unix socket paths cap at ~104 bytes
    (`SUN_LEN`). No auth policy applies on the unix path — filesystem
    permissions are the boundary — while the TCP `ws://` listener carries
    Origin rejection and auth requirements upstream. **`Bun.connect`
    `socket.write` is a partial write** — the macOS unix-socket send buffer
    is 8 KiB, and an ignored remainder truncates the stream mid-frame,
    hanging the peer forever on the declared length (a ~9 KiB
    `thread/start` carrying ORCHESTRATOR.md did exactly this). Every write
    goes through `SocketOutbox` in `attach.ts`, flushed on `drain`.
13. Socket mode is multi-connection and persists across disconnects
    (`single_client_mode` is stdio-only). Each connection runs its own
    `initialize` with `experimentalApi`. Threads and **running turns survive
    a dropped connection**; `thread/resume` works mid-turn and re-subscribes
    the new connection to that thread's notifications. Notifications emitted
    while no connection was attached are **never replayed** — reconcile by
    reading state (`thread/read`), not by waiting.
14. A pre-turn thread has no rollout: `thread/resume` fails with "no rollout
    found", yet the thread may still be loaded in the resident. `runtime.ts`
    deletes such a thread when falling back to a fresh start, so silent
    console restarts don't accumulate empty loaded threads.
15. An **unanswered dynamic tool call parks its turn indefinitely** (thread
    `active`, turn `inProgress`, ≥60 s observed); `turn/interrupt` clears it.
    The answerable connection dies with the console, so on attach the runtime
    interrupts turns stranded on the orchestrator's thread.
16. The realtime surface works identically from a socket connection —
    start/sdp answer/started/stop all verified over `unix://` with the
    ordinary ChatGPT bearer (invariant 10 is model-side, not client-side).

## Conventions

- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (hence Biome's
  `useLiteralKeys` is off).
- Full-screen TUIs are chromeless: no header or footer rows. Critical
  signals (phase, timer, mode) live in body panels — here, centered on the
  signal panel's label and readout rows — and every action lives in the
  ctrl+k command palette (`src/tui/palette.ts`: type to filter, enter to
  run, rows tappable), which is also the key reference. Direct hotkeys
  stay bound while it is closed; ctrl+c always falls through.
- The orchestrator agent's cwd is the user's home directory by default
  (`orchestrator.workspace` overrides it); it is expected to make its own
  per-task working directories rather than write there directly. Nothing
  under the state dir is the agent's workspace.
- State on disk under `~/.local/state/agentvoice/` (`$XDG_STATE_HOME`
  honored): `app-server` (stable resident cwd — must
  outlive the process; it re-reads its own cwd on every thread start),
  `resident/` (0700: the app-server socket, rendered wrapper, pick log, and
  `resident.json` account state), `thread.json` (the persisted orchestrator
  threadId, resumed on attach), `workers.json` (the persisted worker
  registry, reconciled on attach), `console.sock` (owner-only IPC between the
  console and Remote consoles — also the single-console lock),
  `accounts/<slug>` (account profiles: a real `auth.json`, a private
  `app-server-control/`, and a symlink farm over shared canonical `~/.codex`
  state, reconciled at every pick).

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship globally through AgentStart's scan
  (`~/code/agentstart/scripts/sync-skills`, run six-hourly by the scheduled
  updater): a SKILL.md edit is live within six hours, or on demand by
  running that script. Whether a new skill earns a TOOLS.md advertisement
  line is a deliberate decision — `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
- **LaunchAgent exception:** fleet apps normally keep their plists in
  AgentStart, but `com.agentvoice.resident` is rendered and owned *here*
  (`src/resident/install.ts`) — the resident's spawn contract (account pick,
  socket path, realtime flag) is this repo's load-bearing surface, and the
  installer bakes absolute paths that must move with this checkout.
