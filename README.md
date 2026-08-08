# agentvoicenext

Minimal voice system for Codex. `agentvoicenext server` spawns a `codex
app-server`, opens one orchestrator thread in an agent-owned workspace, and
exposes a localhost WebSocket that lets a single voice client hold a
full-duplex WebRTC voice conversation with that thread. `agentvoicenext client`
is that client: a terminal UI with live meters, transcripts, and mute controls.
Audio flows peer-to-peer between the client and the voice model; the
voice↔agent handoff happens inside app-server. Uses your existing ChatGPT/Codex
login — **no OpenAI API key**.

## Requirements

- [bun](https://bun.sh) ≥ 1.3
- [codex CLI](https://github.com/openai/codex) ≥ 0.147 on PATH, logged in
  (`codex login`). Built and verified against codex-cli **0.147.0**; the
  realtime surface is experimental upstream and may shift between releases.
- [sox](https://sox.sourceforge.net) — client speaker playback only.
  `bun run setup` checks everything and installs sox via Homebrew if missing.

## Run

```bash
bun install
bun run setup                        # one-time: verifies bun/codex, installs sox
bun run server                       # all defaults
bun run client                       # in another terminal: the voice TUI
bun run src/main.ts server --model gpt-5.3-codex --effort high --voice marin
```

### A global `agentvoicenext`

`bun run cli:install` installs dependencies, runs setup, and `bun link`s this
checkout, putting `agentvoicenext` on PATH (via bun's global bin, usually
`~/.bun/bin`). The command is **editable** — it symlinks back into the
checkout, so source edits apply immediately with no rebuild. Funk's installer
(`~/code/funk/install`) invokes this same contract from
`~/code/agentvoicenext` when that checkout exists.

```bash
bun run cli:install
agentvoicenext server
```

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | codex config | Orchestrator model — the agent that does the actual work |
| `--effort <level>` | codex config | Orchestrator reasoning effort (`none…ultra`); think-time per turn |
| `--voice-model <id>` | codex config | Realtime speech model — conversational front-end only |
| `--voice <name>` | upstream | Voice timbre (e.g. `marin`, `cove`) |
| `--workspace <dir>` | `~/.local/state/agentvoicenext/workspace` | Directory the agent operates in |
| `--sandbox <mode>` | `danger-full-access` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approval-policy <p>` | `never` | `never` \| `on-request` \| `untrusted` |
| `--port <n>` | `7890` | WebSocket port, bound to `127.0.0.1` only |
| `--codex <path>` | `$CODEX_PATH` or `codex` | Codex binary to spawn |
| `--config <path>` | `~/.config/agentvoicenext/server.yaml` | Config file location |
| `--debug` | off | Log app-server protocol frames to stderr |

## Configuration

`$XDG_CONFIG_HOME/agentvoicenext/server.yaml` (default `~/.config/…`). Keys are
the flag names. Precedence: **CLI > file > default**. An option left unset is
not sent to codex at all, so your `~/.codex/config.toml` applies.

```yaml
model: gpt-5.3-codex
effort: high
voice-model: gpt-realtime
voice: marin
workspace: ~/projects/sandbox
sandbox: danger-full-access
approval-policy: never
port: 7890
codex: /usr/local/bin/codex
```

## Security posture

The server binds `127.0.0.1` only and accepts one client, with no
authentication. The default `danger-full-access` + `never` runs an unattended,
unrestricted agent with your user permissions in the workspace — the legacy
posture, and what makes hands-free "install it and run the tests" work. Safer
mode: `sandbox: workspace-write` + `approval-policy: on-request`. Approval
requests are always **auto-denied** (there is no UI to answer them); the agent
is told no and adapts instead of hanging.

## Terminal client

`agentvoicenext client` connects to a running server and opens a full-duplex
voice console: your microphone is captured in-process (OpenTUI/CoreAudio),
Opus-encoded, and sent over WebRTC; the agent's voice plays through a sox
`play` child and both directions render as live meters with sparkline history.
Finished turns stream in as transcripts (`you · …` / `agent · …`).

```bash
bun run client                                   # defaults to ws://127.0.0.1:7890/ws
bun run src/main.ts client --url ws://127.0.0.1:7890/ws --device 1 --debug
```

- **Keys**: `m` mute mic · `s` mute speaker · `r` redial voice · `q` quit.
  Clicking the YOU panel toggles the mic; clicking AGENT toggles the speaker.
- **Redial** negotiates a fresh voice session against the same conversation
  while the old one keeps playing; audio swaps the moment the new session
  connects. It is the escape hatch when the media path dies silently, and also
  reconnects after a busy rejection (another client held the server), so `r`
  works once the slot is free. Renewal happens automatically before the
  ~60-minute upstream ceiling, using the same near-seamless swap.
- **Headphones recommended**: there is no echo cancellation in this stack, so
  open speakers can let the agent hear itself. `s` is the manual guard.
- macOS microphone permission belongs to your **terminal app** (System
  Settings › Privacy & Security › Microphone, then fully restart it). If the
  mic delivers pure silence the client shows a warning naming this.
- `--debug` writes `~/.local/state/agentvoicenext/client-debug.log` including
  every upstream event.

## Client API

Protocol version **1**. `GET /` returns `{"name":"agentvoicenext","version":…,"protocol":1}`
as a health/discovery check. WebSocket endpoint: `ws://127.0.0.1:<port>/ws`.
The bundled terminal client speaks exactly this protocol.

One client at a time — a second connection is closed with code **4429**. On
server shutdown the client is closed with **1001**. The server pings; the
socket is legitimately silent for minutes while audio flows peer-to-peer.

### Messages: client → server

| Message | Shape |
|---|---|
| `offer` | `{"type":"offer","sdp":"<complete SDP offer>"}` |

An offer is accepted any time after the most recent `ready`. Sending a new
offer while a session is running **supersedes** it (this is how you renew) —
the superseded session ends silently, with no `closed` message. Anything else
gets a non-fatal `error`.

### Messages: server → client

| Message | Shape | Meaning |
|---|---|---|
| `ready` | `{"type":"ready","protocol":1,"threadId":…,"workspace":…,"model":…,"effort":…,"voiceModel":…,"voice":…}` | Offers are accepted now. Sent on connect and re-sent whenever offers reopen (after `closed`, after a fatal `error`, after an internal restart). `null` fields mean "codex default". |
| `answer` | `{"type":"answer","sdp":…}` | The WebRTC answer; apply with `setRemoteDescription`. |
| `closed` | `{"type":"closed","reason"?:…}` | The voice session ended (`transport_closed` at the upstream ceiling, `app-server-exited` on an internal restart, …). Wait for the next `ready`, then re-offer if desired. |
| `error` | `{"type":"error","message":…,"code"?:…,"fatal":bool}` | `fatal:true` (code `realtime-failed`): the session is dead — **stop your microphone tracks and close the peer**, then wait for `ready` to try again. `fatal:false` is informational (`not-ready`, `bad-offer`, `unknown-message`, `bad-message`). |

### WebRTC recipe

1. `getUserMedia({audio: {echoCancellation: false, noiseSuppression: true, autoGainControl: true}})`
2. `pc = new RTCPeerConnection()` — no ICE servers needed
3. `pc.addTrack(micTrack, stream)`
4. `pc.createDataChannel("oai-events")` — required; the upstream peer expects this exact channel
5. `offer = await pc.createOffer({offerToReceiveAudio: true})`; `setLocalDescription(offer)`
6. **Wait for ICE gathering to complete** (cap ~3 s) — the offer travels whole; there is no trickle channel
7. Send `{"type":"offer","sdp":pc.localDescription.sdp}`; on `answer`, `setRemoteDescription({type:"answer",sdp})`
8. Play remote audio from `pc.ontrack`; speak. Mute locally with `track.enabled = false` — the server is not involved

### Session lifetime and renewal

- The session ends when your socket closes; closing the tab hangs up.
- Upstream sessions live ~60 minutes. To renew, build a **new** peer + offer
  before the ceiling (the bundled client uses 52 minutes) and send it — the
  server supersedes the old session silently. Keep the old peer playing until
  the new one reaches `connected`, then swap audio to it and close the old
  peer. The audible gap is the upstream call setup (~1–2 s); the superseded
  peer lingers with a dead control plane, so closing it is your job.
- If the connection dies (peer state `failed`, or `closed` arrives), re-offer
  after the next `ready` with a fresh peer.

## State on disk

- `~/.local/state/agentvoicenext/workspace` — default agent workspace.
- `~/.local/state/agentvoicenext/app-server` — stable working directory for the
  app-server child process (it re-reads its own cwd on every thread start;
  leave it in place). `$XDG_STATE_HOME` is honored.

Conversation state is in-memory per run: each server start opens a fresh
orchestrator thread (surviving app-server restarts within the run).
