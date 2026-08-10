# agentvoice

[![CI](https://github.com/possibilities/agentvoice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentvoice/actions/workflows/ci.yml)

Minimal voice system for Codex. `agentvoice server` spawns a `codex
app-server`, opens one **orchestrator agent** in an agent-owned workspace, and
exposes a localhost WebSocket that lets a single voice client hold a
full-duplex WebRTC voice conversation with it. `agentvoice client` is that
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
- [Zig](https://ziglang.org/) or a C11 compiler — the client's duplex audio
  device is built from source and it has no other audio path. `bun run setup`
  builds it, preferring Zig and falling back to `clang`/`cc`.

## Run

```bash
bun install
bun run setup                        # one-time: verifies bun/codex, builds duplex audio
bun run server                       # all defaults
bun run client                       # in another terminal: the voice TUI
bun run src/main.ts server --model gpt-5.6-sol --effort high --voice cove
```

### A global `agentvoice`

`bun run cli:install` installs dependencies, runs setup, and `bun link`s this
checkout, putting `agentvoice` on PATH (via bun's global bin, usually
`~/.bun/bin`). The command is **editable** — it symlinks back into the
checkout, so TypeScript edits apply immediately with no rebuild. Funk's
installer (`~/code/funk/install`) invokes this same contract from
`~/code/agentvoice` when that checkout exists.

TypeScript edits remain immediate. Changes under `src/client/native/` require
`bun run native:build`; `bun run cli:install` runs that build automatically.

```bash
bun run cli:install
agentvoice server
```

Flags cover the handful of things worth changing per run; the full surface
lives in the config file.

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | codex config | Orchestrator agent model — the agent that does the actual work |
| `--effort <level>` | codex config | Orchestrator agent reasoning effort (`none…ultra`); think-time per turn |
| `--voice-model <id>` | codex config | Voice agent model — conversational front-end only |
| `--voice <name>` | upstream | Voice timbre (e.g. `marin`, `cove`) |
| `--workspace <dir>` | `~/.local/state/agentvoice/workspace` | Directory the orchestrator agent operates in |
| `--sandbox <mode>` | `danger-full-access` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approval-policy <p>` | `never` | `never` \| `on-request` \| `untrusted` |
| `--port <n>` | `7890` | WebSocket port, bound to `127.0.0.1` only |
| `--codex <path>` | `$CODEX_PATH` or `codex` | Codex binary to spawn |
| `--config <path>` | `~/.config/agentvoice/server.json` | Config file location |
| `--debug` | off | Log app-server protocol frames to stderr |

## Configuration

`$XDG_CONFIG_HOME/agentvoice/server.json` (default `~/.config/…`).
Precedence: **CLI > file > default**. An option left unset is not sent to codex
at all, so your `~/.codex/config.toml` applies — the defaults add no opinions
of their own.

This section is the surface; **[the agent priming field
guide](docs/field-guide.md)** is the depth — every lever that shapes either
agent's behavior, verified against codex 0.147 source and live probes, with
compaction and restart semantics, gotchas, and recipes.

**[`server.schema.json`](server.schema.json) documents the complete surface** —
every key, type, enum, and default, surfaced as autocomplete and hover docs in
any editor that honors the `$schema` key. [`server.json.example`](server.json.example)
is the starting point; copying it verbatim behaves exactly like having no
config file:

```bash
cp server.json.example ~/.config/agentvoice/server.json
```

Keys nest by which agent they prime, not by which call carries them. `config`
holds raw `~/.codex/config.toml` overrides; each `extra` is a raw RPC
passthrough:

```json
{
  "$schema": "./server.schema.json",
  "port": 7890,
  "orchestrator": {
    "workspace": "~/projects/sandbox",
    "model": "gpt-5.6-sol",
    "effort": "high",
    "personality": "pragmatic",
    "sandbox": "danger-full-access",
    "approval-policy": "never",
    "config": {},
    "extra": {}
  },
  "voice": {
    "name": "cove",
    "version": "v3",
    "include-startup-context": false,
    "extra": {}
  }
}
```

Each `extra` block is merged last into its RPC, so anything the protocol
accepts but this config does not name yet is still reachable — useful because
the realtime surface is experimental upstream. Beware: upstream ignores
unknown fields rather than rejecting them, so a typo in `extra:` is silently
dropped — verify against a `--debug` frame when a knob seems dead. (The same
applies inside `config` and `extra` to the JSON Schema: it declares them as
free-form objects, so editor validation ends at their boundary.)

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
including its tool discipline — the server warns at boot when it is present
(it also silently disables `orchestrator.personality`). And while
`ORCHESTRATOR_SESSION_START.md` rides on **every** redial, codex delivers it
to the orchestrator only when a voice session actually opens after being
closed — not on renewals — and repeats it after every context compaction
while a session is live, so keep it short. Details and verified semantics:
[the field guide](docs/field-guide.md).

### Worker dispatch

`orchestrator.dispatch: true` declares three dynamic tools on the
orchestrator's thread — `dispatch_worker`, `check_workers`, `cancel_worker` —
answered by this server. A dispatched worker is a sibling codex thread with
its own context: it inherits the orchestrator's execution posture (sandbox,
approvals, model, `config:` layer) but no prompt files and no dispatch tools.
The orchestrator's turn ends immediately with a speakable handle (`w1`);
workers die with the app-server child and are reported as `lost` rather than
resumed.

Completion has two modes, and the tool descriptions promise whichever one is
on. The default is **pull-only**: nothing is pushed when a worker finishes;
`check_workers` reads status and results. `orchestrator.dispatch-reports:
true` turns on the **evented** mode: the server starts a `<worker_report>`
turn on the orchestrator's thread carrying the status and the worker's final
message — upstream admission steers it into a running turn or opens a fresh
one, so reports land whether or not a conversation is mid-flight. Evented is
the mode a fire-and-forget doctrine is written against; it stays opt-in
because unprompted turns arriving at an unprimed orchestrator are an opinion,
and the defaults here add none. Pairs with `agents.enabled: false` in
`orchestrator.config:`, which removes codex's own in-thread sub-agent tools
so the two surfaces never compete.

### Multi-account balancing

`accounts.balance: true` makes the server pick which ChatGPT account each
app-server child runs on, using live quota data. Selection is delegated to
`agentusage balance codex` (falling back to `codex-swap select`), so the
balancing algorithm, freshness rules, and focus policies live with the quota
observer rather than here; the pick maps by email onto an
**account profile** — a per-account `CODEX_HOME` under
`~/.local/state/agentvoice/accounts/<slug>/` holding its own `auth.json`
while symlinking everything else to the canonical `~/.codex`. One shared
session store is what lets the orchestrator thread resume under any account.

```bash
agentvoice accounts add personal   # codex login --device-auth, per account
agentvoice accounts add work
agentvoice accounts list
```

Selection runs at every child spawn (boot and supervised restarts). When the
active account crosses `accounts.switch-threshold` (default 95% of either
rate-limit window), the server rotates: at the next idle moment — no voice
session, no running turn, no live workers — it restarts the child onto the
balancer's next pick and resumes the same orchestrator thread.

Refusal posture: balancing on with codex-swap installed but **no profile
logged in is a configuration error — boot exits with the exact
`accounts add` commands** for the registered pool. Everything else degrades:
without the balancer CLIs the same config quietly runs the canonical
`~/.codex` (one config deploys to every machine), and transient refusals
mid-run (nothing eligible, balancer hiccup) fall back loudly for that spawn.
With balancing off, behavior is exactly the single-account default.

Two things this deliberately never does: copy credentials between stores
(ChatGPT refresh tokens rotate with reuse detection — each profile is its own
grant, logged in once, refreshed only by codex), and wrap the child in
`codex-swap run` (its credential proxy swaps the model provider out from
under the realtime surface; see AGENTS.md invariant 10).

The server binds `127.0.0.1` only — hardcoded, not configurable — and accepts
one client. Loopback alone is not a boundary: a web page can open a WebSocket
to 127.0.0.1 (the handshake is exempt from the same-origin policy), and other
local users share the interface. So every request also passes a three-part
handshake gate:

- **Connection token.** Created at first boot as
  `~/.local/state/agentvoice/token` (mode 0600) and required on every
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
agentvoice client --token <contents of the laptop's token file>
```

## Terminal client

`agentvoice client` connects to a running server and opens a full-duplex
voice console. Capture and playback both run on one client-owned miniaudio
duplex device with bounded PCM rings; audio is exchanged as Opus over WebRTC,
and the console renders live meters, sparklines, and finished-turn transcripts
(`you · …` / `agent · …`).

```bash
bun run client                                   # defaults to ws://127.0.0.1:7890/ws
bun run src/main.ts client --url ws://127.0.0.1:7890/ws --device 1 --debug
```

The device requests 48 kHz s16 mono capture and stereo playback from one
`ma_device_type_duplex`; miniaudio negotiates the physical device formats.
Playback holds a 500 ms playout cushion on start/rebuffer in a ring with 1 s
of capacity. Use `--output-device` to select a non-default speaker, or
`bun run audio:probe --device 1` to enumerate and briefly open the real duplex
device without starting a voice session.

The device is built from source and the client refuses to start without it —
`bun run setup` builds it, and `bun run native:build` rebuilds after editing
`src/client/native/`.

- **Keys**: `m` mute mic · `s` mute speaker · `r` redial voice · `q` quit.
  Clicking the YOU panel toggles the mic; clicking AGENT toggles the speaker.
- **Token**: read automatically from `~/.local/state/agentvoice/token`;
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
- `--debug` writes `~/.local/state/agentvoice/client-debug.log` including
  audio-device inventory, decoded/playback cadence, physical device formats,
  callback cadence, RTP arrival-gap and handler-time distributions, ring
  occupancy, drops, callback-level starvation events, reroutes, and
  interruption counters, plus every upstream event.

## Client API

Protocol version **1**. `GET /` returns `{"name":"agentvoice","version":…,"protocol":1}`
as a health/discovery check. WebSocket endpoint:
`ws://127.0.0.1:<port>/ws?token=<token>`, where the token is the contents of
`~/.local/state/agentvoice/token` on the server machine. The bundled
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
| `worker` | `{"type":"worker","worker":{"id":…,"title":…,"status":…,"startedAt":…,"finishedAt"?:…,"report"?:…}}` | A dispatched worker changed state ([worker dispatch](#worker-dispatch)); `status` is `running`, `completed`, `failed`, `interrupted`, `cancelled`, or `lost`. Known workers are replayed on connect, so a UI joining mid-run starts complete. Additive — absent unless `orchestrator.dispatch` is on. |

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

- `~/.local/state/agentvoice/workspace` — default orchestrator workspace.
  An `AGENTS.md` here reaches the orchestrator agent the ordinary codex way.
- `~/.local/state/agentvoice/app-server` — stable working directory for the
  app-server child process (it re-reads its own cwd on every thread start;
  leave it in place). `$XDG_STATE_HOME` is honored.
- `~/.local/state/agentvoice/token` — the connection token (created at
  first boot, mode 0600). Delete it to rotate; the next server start mints a
  fresh one.
- `~/.local/state/agentvoice/accounts/<slug>` — account profiles for
  multi-account balancing: a real `auth.json` per account, everything else
  symlinked to `~/.codex`. Safe to delete; recreate with
  `agentvoice accounts add`.
- `~/.config/agentvoice/` — `server.json` (with `server.schema.json` beside
  it for editor validation) and the prompt files beside it.

Conversation state is in-memory per run: each server start opens a fresh
orchestrator agent (surviving app-server restarts within the run). Prompt files
are read once at boot, so editing one takes effect on the next server start.
