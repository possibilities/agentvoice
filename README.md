# agentvoicenext

Minimal voice system for Codex. `agentvoicenext server` spawns a `codex
app-server`, opens one **orchestrator agent** in an agent-owned workspace, and
exposes a localhost WebSocket that lets a single voice client hold a
full-duplex WebRTC voice conversation with it. `agentvoicenext client` is that
client: a terminal UI with live meters, transcripts, and mute controls.

There are two agents. The **voice agent** is the realtime speech model you
actually talk to; the **orchestrator agent** is the Codex thread that does the
work. Audio flows peer-to-peer between the client and the voice agent, and the
handoff between the two agents happens inside app-server. Both can be primed —
see [Configuration](#configuration). Uses your existing ChatGPT/Codex login —
**no OpenAI API key**.

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

Flags cover the handful of things worth changing per run; the full surface
lives in the config file.

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | codex config | Orchestrator agent model — the agent that does the actual work |
| `--effort <level>` | codex config | Orchestrator agent reasoning effort (`none…ultra`); think-time per turn |
| `--voice-model <id>` | codex config | Voice agent model — conversational front-end only |
| `--voice <name>` | upstream | Voice timbre (e.g. `marin`, `cove`) |
| `--workspace <dir>` | `~/.local/state/agentvoicenext/workspace` | Directory the orchestrator agent operates in |
| `--sandbox <mode>` | `danger-full-access` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approval-policy <p>` | `never` | `never` \| `on-request` \| `untrusted` |
| `--port <n>` | `7890` | WebSocket port, bound to `127.0.0.1` only |
| `--codex <path>` | `$CODEX_PATH` or `codex` | Codex binary to spawn |
| `--config <path>` | `~/.config/agentvoicenext/server.yaml` | Config file location |
| `--debug` | off | Log app-server protocol frames to stderr |

## Configuration

`$XDG_CONFIG_HOME/agentvoicenext/server.yaml` (default `~/.config/…`).
Precedence: **CLI > file > default**. An option left unset is not sent to codex
at all, so your `~/.codex/config.toml` applies — the defaults add no opinions
of their own.

**[`server.yaml.example`](server.yaml.example) is the complete surface**, every
key documented and commented out. Copying it verbatim behaves exactly like
having no config file:

```bash
cp server.yaml.example ~/.config/agentvoicenext/server.yaml
```

Keys nest by which agent they prime, not by which call carries them:

```yaml
port: 7890

orchestrator:                    # the Codex thread that does the work
  workspace: ~/projects/sandbox
  model: gpt-5.3-codex
  effort: high
  personality: pragmatic
  sandbox: danger-full-access
  approval-policy: never
  config: {}                     # raw ~/.codex/config.toml overrides
  extra: {}                      # raw thread/start passthrough

voice:                           # the realtime model you talk to
  model: gpt-realtime
  name: marin
  version: v3
  include-startup-context: false
  extra: {}                      # raw thread/realtime/start passthrough
```

Each `extra:` block is merged last into its RPC, so anything the protocol
accepts but this config does not name yet is still reachable — useful because
the realtime surface is experimental upstream. Typos there surface as RPC
errors at boot rather than config errors.

### Prompts

Prompt content is never named in the config. Files are found by convention in
the config file's own directory, so `--config` relocates the whole bundle. All
are optional, and **none exist by default, so nothing is injected**.

| File | Primes | Effect |
|---|---|---|
| `VOICE.md` | voice agent | **Replaces** its system prompt |
| `VOICE_SEED_DEVELOPER.md` | voice agent | Seeds the session as a `developer` item |
| `VOICE_SEED_USER.md` | voice agent | … as a `user` item |
| `VOICE_SEED_ASSISTANT.md` | voice agent | … as an `assistant` item (e.g. a greeting) |
| `ORCHESTRATOR.md` | orchestrator agent | Appended to its instructions |
| `ORCHESTRATOR_BASE.md` | orchestrator agent | **Replaces** its system prompt |
| `ORCHESTRATOR_SESSION_START.md` | orchestrator agent | Told to it when voice opens |
| `ORCHESTRATOR_SESSION_END.md` | orchestrator agent | … and when it closes |

Three states, so you can strip a built-in prompt as well as replace it:

- **absent** — codex's built-in prompt stands
- **present, with content** — your text replaces or appends, per the table
- **present, empty** — the field is sent empty, stripping the built-in prompt

Seed files become `initialItems` in fixed developer → user → assistant order,
one item each; for interleaving or repeats use `voice.extra.initialItems`. The
server prints which prompt files it found at boot, and the client shows the
count in its session panel.

Two cautions. `ORCHESTRATOR_BASE.md` replaces codex's *entire* system prompt
including its tool discipline — the server warns at boot when it is present.
And `ORCHESTRATOR_SESSION_START.md` is re-sent on **every** redial (renewal,
recovery, and manual `r`), so keep it short.

## Security posture

The server binds `127.0.0.1` only — hardcoded, not configurable — and accepts
one client. Loopback alone is not a boundary: a web page can open a WebSocket
to 127.0.0.1 (the handshake is exempt from the same-origin policy), and other
local users share the interface. So every request also passes a three-part
handshake gate:

- **Connection token.** Created at first boot as
  `~/.local/state/agentvoicenext/token` (mode 0600) and required on every
  WebSocket handshake (`/ws?token=…`). The bundled client reads the same file
  automatically, so same-machine use needs no setup; a missing or wrong token
  is closed with code **4401**. File permissions are the boundary between
  local users.
- **Origin rejection.** Any request carrying an `Origin` header is refused
  (403). Browsers attach one to every WebSocket handshake, so this closes the
  drive-by class outright — malicious pages and injected captive-portal
  scripts probing localhost from your own browser. A browser page deliberately
  cannot be a client of this server.
- **Host pinning.** Requests must name `127.0.0.1:<port>` or
  `localhost:<port>` (421 otherwise), refusing DNS-rebinding hostnames.

The gate decides who reaches the agent; it cannot constrain what the agent
then does. Approval requests are always **auto-denied** (there is no UI to
answer them; the agent is told no and adapts instead of hanging), so the
**sandbox is the only real guardrail**. The default `danger-full-access` +
`never` runs an unattended, unrestricted agent with your user permissions in
the workspace — what makes hands-free "install it and run the tests" work.
On untrusted networks (hotel, café), prefer `--sandbox workspace-write`.

To talk to your laptop from another device, do **not** expose the port —
tunnel to loopback and carry the token across once:

```bash
ssh -N -L 7890:127.0.0.1:7890 laptop        # or a Tailscale/WireGuard route
agentvoicenext client --token <contents of the laptop's token file>
```

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
- **Token**: read automatically from `~/.local/state/agentvoicenext/token`;
  `--token` overrides it when the server's state directory is not yours
  (tunneled or remote server).
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
as a health/discovery check. WebSocket endpoint:
`ws://127.0.0.1:<port>/ws?token=<token>`, where the token is the contents of
`~/.local/state/agentvoicenext/token` on the server machine. The bundled
terminal client speaks exactly this protocol. Requests carrying an `Origin`
header are refused, so a web page cannot connect ([Security
posture](#security-posture)) — build clients on a native WebRTC stack (the
bundled client uses [werift](https://github.com/shinyoshiaki/werift-webrtc);
the recipe below uses the standard API names, which those stacks mirror).

One client at a time — a second connection is closed with code **4429**, and a
missing or wrong token with **4401**. On server shutdown the client is closed
with **1001**. The server pings; the socket is legitimately silent for minutes
while audio flows peer-to-peer.

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
| `ready` | `{"type":"ready","protocol":1,"threadId":…,"workspace":…,"model":…,"effort":…,"voiceModel":…,"voice":…,"prompts":[…]}` | Offers are accepted now. Sent on connect and re-sent whenever offers reopen (after `closed`, after a fatal `error`, after an internal restart). `null` fields mean "codex default"; `prompts` lists the prompt filenames priming the agents. |
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

- `~/.local/state/agentvoicenext/workspace` — default orchestrator workspace.
  An `AGENTS.md` here reaches the orchestrator agent the ordinary codex way.
- `~/.local/state/agentvoicenext/app-server` — stable working directory for the
  app-server child process (it re-reads its own cwd on every thread start;
  leave it in place). `$XDG_STATE_HOME` is honored.
- `~/.local/state/agentvoicenext/token` — the connection token (created at
  first boot, mode 0600). Delete it to rotate; the next server start mints a
  fresh one.
- `~/.config/agentvoicenext/` — `server.yaml` and the prompt files beside it.

Conversation state is in-memory per run: each server start opens a fresh
orchestrator agent (surviving app-server restarts within the run). Prompt files
are read once at boot, so editing one takes effect on the next server start.
