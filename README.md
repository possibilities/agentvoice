# Codpiece

Talk to a coding agent. Codpiece is a voice layer: a Codex-derived **voice
sidecar** that holds the realtime conversation, an **orchestrator adapter**
that hands the work to whichever coding agent is behind it, and a **frontend**
that owns the microphone and speaker. The first frontend is a terminal screen;
the backend of record is Fx over the Agent Client Protocol.

```text
you ⇄ microphone / speaker (this process)
        ⇅ WebRTC, peer to peer
voice agent (gpt-live-1-codex, cove) ── signaling ── voice sidecar (Codpiece)
        ⇅ delegations and speech handoffs
orchestrator adapter ── fx acp ── Fx (gpt-5.6-terra, medium) ── your workspace
```

The sidecar proxies SDP and sideband only; audio never touches it. The voice
agent decides when a request is coding work and delegates it; the adapter
admits that text into the orchestrator, streams progress back as speech, and
reports the final result. A second request while work is running is admitted
into the running turn once Fx serves in-flight steering over ACP; until then
it is queued behind it and reported as such.

## Requirements

- macOS, [bun](https://bun.sh) ≥ 1.4, and Zig or a C11 compiler for the
  native duplex audio device (`bun run native:build`).
- `fx` on `PATH`, logged in to a Codex subscription (`fx status` shows
  `auth: Codex subscription`).
- A Codpiece voice sidecar binary with its `metadata.json` beside it. A
  schema-2 sidecar authenticates with your existing Codex login; a schema-3
  sidecar takes its authority from Fx over inherited descriptor 3 and needs the
  `fx-work-control` backend until Fx serves the credential broker over ACP.
- Headphones. There is no acoustic echo cancellation yet.

## Run

```bash
bun install
bun run native:build
bun run tui -- --voice-sidecar PATH --workspace DIR
```

The microphone opens muted. Hold `Space` to talk; `m` toggles the mic, `s` the
speaker, `r` redials the voice session, `q` quits. Holding `m` or `s` opens a
muted channel for the hold only. `--backend fx-work-control` uses the
PTY-launched reference adapter instead of ACP; `--model`, `--effort`, and
`--voice` override the defaults; `--mic`/`--speaker` choose device indexes;
`--debug-log PATH` writes the event journal on exit.

## Layout

- `src/tui/` — the frontend: `main.ts` assembles everything; `app.ts` draws;
  `duplex-device.ts` and `native/` are the audio device; `duplex-audio.ts` is
  Opus in and out; `voice-transport.ts` is the WebRTC peer;
  `voice-session.ts` drives the sidecar; `mute-gate.ts` is the mute doctrine.
- `src/orchestrator-adapter.ts` — the contract every backend implements.
  `src/fx-acp-adapter.ts` is the backend of record; `src/fx-orchestrator.ts`
  is the reference adapter over Fx's work-control socket and ADE feed.
- `src/codex-fx-bridge.ts` and `src/fx-delegation.ts` — delegations in,
  speech handoffs out.
- `src/app-server.ts` — the sidecar's JSON-RPC client and process isolation.
- `docs/adr/` — the decisions; `CONTEXT.md` — the words.

## Develop

```bash
bun test          # unit tests, a fake sidecar, and an in-process WebRTC loopback
bun run typecheck
bun run lint
```

Tests never open an audio device. The sidecar itself lives in the
[Codpiece workshop](https://github.com/possibilities/codpiece) and its fork of
Codex; Fx's carries live in the fxnk workshop.
