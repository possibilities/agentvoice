# agentvoicenext — repository guidance

Minimal voice system for Codex: a coordination server over `codex app-server`'s
realtime (WebRTC) surface, plus a terminal voice client. Read `README.md` for
usage and the wire protocol, `CONTEXT.md` for the glossary — use its canonical
terms in code, comments, and commit messages.

## Commands

- `bun test` — unit tests (pure logic only; no codex or audio needed)
- `bun run typecheck` — `tsc --noEmit`, strict with `noUncheckedIndexedAccess`
- `bun run lint` / `bun run format` — Biome check / autofix
- `bun run server` / `bun run client` — the real thing (needs codex ≥ 0.147
  logged in; client also needs sox and a microphone)

## Map

`src/` root is the shared surface — only what both sides need. Everything else
belongs to exactly one side. Adding a root-level module is a claim that both
the server and the client use it; if only one does, it goes in that directory.

- `src/main.ts` — CLI entry, flag parsing; dispatches both commands
- `src/protocol.ts` — client↔server wire messages; both sides import it
- `src/paths.ts` — XDG path resolution; the client needs the state directory
- `src/server/`
  - `config.ts` — config resolution (CLI > `server.yaml` > default); unset
    options are not sent to codex at all. Values nest under `orchestrator` and
    `voice` by which agent they prime, not by which RPC carries them. Also owns
    prompt-file discovery (`PROMPT_FILES`)
  - `params.ts` — pure config+prompts → `thread/start`, `thread/resume`, and
    `thread/realtime/start` payloads; tested in `tests/params.test.ts`
  - `appserver.ts` — JSON-RPC over stdio to the app-server child; framing,
    supervision, fail-closed denial of approval requests
  - `session.ts` — the voice-session state machine (supersede, attribution);
    pure effects-injected logic, tested in `tests/session.test.ts`
  - `server.ts` — wiring: process supervision, thread, WebSocket
- `src/client/` — terminal client: `transport.ts` (WebSocket + werift WebRTC,
  two-peer redial), `audio.ts` (mic capture → Opus; Opus → sox playback),
  `dsp.ts` (pure audio math, tested), `ui.ts` (OpenTUI console)
- `server.yaml.example` — the whole config surface, every key commented out.
  Copying it verbatim must stay a no-op; a test asserts that. Add new keys here
  the same commit you add them to `config.ts`.

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

## Conventions

- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (hence Biome's
  `useLiteralKeys` is off).
- State on disk under `~/.local/state/agentvoicenext/` (`$XDG_STATE_HOME`
  honored): `workspace` (agent cwd), `app-server` (stable child cwd — must
  outlive the child; it re-reads its own cwd on every thread start).
