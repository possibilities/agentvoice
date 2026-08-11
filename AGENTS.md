# agentvoice — repository guidance

Minimal voice system for Codex: a coordination server over `codex app-server`'s
realtime (WebRTC) surface, plus a terminal voice client. Read `README.md` for
usage and the wire protocol, `CONTEXT.md` for the glossary — use its canonical
terms in code, comments, and commit messages.

## Commands

- `bun test` — unit tests (pure logic only; no codex or audio needed)
- `bun run typecheck` — `tsc --noEmit`, strict with `noUncheckedIndexedAccess`
- `bun run lint` / `bun run format` — Biome check / autofix
- `bun run server` / `bun run client` — the real thing (needs codex ≥ 0.147
  logged in; the client also needs a built duplex device and a microphone)
- `bun run native:build` / `bun run audio:probe` — build and exercise the
  duplex audio device (needs Zig or a C11 compiler; the probe needs audio
  hardware). `bun run setup` builds it; the client will not start without it

## Map

`src/` root is the shared surface — only what both sides need. Everything else
belongs to exactly one side. Adding a root-level module is a claim that both
the server and the client use it; if only one does, it goes in that directory.

- `src/main.ts` — CLI entry, flag parsing; dispatches both commands
- `src/protocol.ts` — client↔server wire messages; both sides import it
- `src/paths.ts` — XDG path resolution; the client needs the state directory
- `src/server/`
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
  - `gate.ts` — the handshake gate: pure Origin/Host/token checks every HTTP
    request passes before the WebSocket; tested in `tests/gate.test.ts`
  - `appserver.ts` — JSON-RPC over stdio to the app-server child; framing,
    supervision, fail-closed denial of approval requests (an optional
    `onRequest` answerer may claim a request first; everything else denies)
  - `session.ts` — the voice-session state machine (supersede, attribution);
    pure effects-injected logic, tested in `tests/session.test.ts`
  - `workers.ts` — worker dispatch under `orchestrator.dispatch`: the three
    dynamic tools, the worker registry, and worker-report composition; pure
    effects-injected logic, tested in `tests/workers.test.ts`
  - `accounts.ts` — account profiles and balanced selection under
    `accounts.balance`: identity/balancer-output parsing (pure), the symlink
    farm, selection with canonical fallback; tested in
    `tests/accounts.test.ts`, upstream mechanics re-verified by
    `scripts/account-profiles-probe.ts`
  - `server.ts` — wiring: process supervision, thread, worker threads,
    WebSocket, account rotation at idle
- `src/client/` — terminal client: `transport.ts` (WebSocket + werift WebRTC,
  two-peer redial), `duplex-audio.ts` + `duplex-device.ts` + `native/` (the
  duplex audio device — the only audio path), `dsp.ts` (pure audio math,
  tested), `ui.ts` (OpenTUI console)
- `server.schema.json` — the whole config surface, every key typed and
  documented; generated from the zod schema in `src/server/config-schema.ts`
  by `bun run generate:schema` (a test fails on drift, and the generator
  throws on an undocumented key). `server.json.example` must stay a
  verbatim-copy no-op; a test asserts that. Adding a config key means
  declaring and describing it in `config-schema.ts` — the loader and the
  published schema both follow, and the drift gate enforces regeneration.

**One `AGENTS.md`, at the root.** Codex loads only the chain from the project
root down to the thread's cwd and never descends into subdirectories
(`codex-rs/core/src/agents_md.rs`; confirmed on 0.147 with a two-level probe).
Since codex runs here with cwd at the repo root, a `src/server/AGENTS.md` would
be read *never* — it would rot unnoticed. This differs from Claude Code, which
loads a subtree `CLAUDE.md` on demand when it reads files there.

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
   (the bundled client does, when the successor connects).
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

## Conventions

- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (hence Biome's
  `useLiteralKeys` is off).
- State on disk under `~/.local/state/agentvoice/` (`$XDG_STATE_HOME`
  honored): `workspace` (agent cwd), `app-server` (stable child cwd — must
  outlive the child; it re-reads its own cwd on every thread start), `token`
  (the connection token, mode 0600 — file permissions are the boundary
  between local users), `accounts/<slug>` (account profiles: a real
  `auth.json` plus a symlink farm over the canonical `~/.codex`, reconciled
  at every child spawn).

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
