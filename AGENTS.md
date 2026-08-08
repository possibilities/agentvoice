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

- `src/main.ts` — CLI entry, flag parsing
- `src/config.ts` — config resolution (CLI > `server.yaml` > default); unset
  options are not sent to codex at all
- `src/appserver.ts` — JSON-RPC over stdio to the app-server child; framing,
  supervision, fail-closed denial of approval requests
- `src/session.ts` — the voice-session state machine (supersede, attribution);
  pure effects-injected logic, tested in `tests/session.test.ts`
- `src/protocol.ts` — client↔server wire messages; both sides import it
- `src/server.ts` — wiring: process supervision, thread, WebSocket
- `src/client/` — terminal client: `transport.ts` (WebSocket + werift WebRTC,
  two-peer redial), `audio.ts` (mic capture → Opus; Opus → sox playback),
  `dsp.ts` (pure audio math, tested), `ui.ts` (OpenTUI console)

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

## Conventions

- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (hence Biome's
  `useLiteralKeys` is off).
- State on disk under `~/.local/state/agentvoicenext/` (`$XDG_STATE_HOME`
  honored): `workspace` (agent cwd), `app-server` (stable child cwd — must
  outlive the child; it re-reads its own cwd on every thread start).
