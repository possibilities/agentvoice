# AgentVoice

[![CI](https://github.com/possibilities/agentvoice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentvoice/actions/workflows/ci.yml)

Minimal voice system for Codex — talk to a coding agent, hands-free.

`agentvoice` is one voice console: a terminal UI with live meters,
transcripts, and mute controls that holds a full-duplex WebRTC conversation
with a Codex agent. The only other process is the **resident** — a bare
`codex app-server` kept alive by launchd, serving a private unix socket the
console attaches to. Threads and dispatched workers live in the resident, so
they survive console restarts; the console resumes the same **orchestrator
agent** every time it starts.

There are two agents. The **voice agent** is the realtime speech model you
actually talk to; the **orchestrator agent** is the Codex thread that does the
work. Audio flows peer-to-peer between the console and the voice agent, and
the handoff between the two agents happens inside app-server. Both can be
primed — see [Configuration](#configuration). Uses your existing ChatGPT/Codex
login — **no OpenAI API key**.

## Requirements

- macOS (the resident is a launchd LaunchAgent)
- [bun](https://bun.sh) ≥ 1.3
- [codex CLI](https://github.com/openai/codex) ≥ 0.147 on PATH, logged in
  (`codex login`). Built and verified against codex-cli **0.147.0**; the
  realtime surface is experimental upstream and may shift between releases.
- [Zig](https://ziglang.org/) or a C11 compiler — the console's duplex audio
  device is built from source and it has no other audio path. `bun run setup`
  builds it, preferring Zig and falling back to `clang`/`cc`.

## Run

```bash
bun install
bun run setup                        # one-time: verifies bun/codex, builds duplex audio
bun run src/main.ts resident install # one-time: install + start the resident
bun run console                      # the voice console
bun run src/main.ts --model gpt-5.6-sol --effort high --voice cove
```

### A global `agentvoice`

`bun run cli:install` installs dependencies, runs setup, and `bun link`s this
checkout, putting `agentvoice` on PATH (via bun's global bin, usually
`~/.bun/bin`). The command is **editable** — it symlinks back into the
checkout, so TypeScript edits apply immediately with no rebuild. AgentStart's
installer (`~/code/agentstart/scripts/install-agent-clis`) invokes this same
contract from `~/code/agentvoice` when that checkout exists.

Two exceptions need explicit steps: changes under `src/console/native/`
require `bun run native:build` (run automatically by `bun run cli:install`),
and the resident's rendered wrapper/plist bake absolute paths — rerun
`agentvoice resident install` after moving the checkout, bun, or codex.

```bash
bun run cli:install
agentvoice resident install
agentvoice
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
| `--codex <path>` | `$CODEX_PATH` or `codex` | Codex binary the resident runs |
| `--device <index>` | system default | Microphone device index |
| `--output-device <index>` | system default | Speaker device index |
| `--fresh` | off | Abandon the persisted orchestrator agent; start a fresh thread |
| `--config <path>` | `~/.config/agentvoice/server.json` | Config file location |
| `--debug` | off | Write protocol and media traces to the state directory |

## The resident

The resident is deliberately vendor-only: launchd runs a rendered wrapper
script that consults the account balancer (see
[balancing](#multi-account-balancing)), then `exec`s
`codex app-server --enable realtime_conversation --listen unix://…`. No
agentvoice code stays resident, so console-side edits never require touching
it — only codex upgrades or moved paths do (`agentvoice resident install` is
idempotent; rerun it).

```bash
agentvoice resident install    # render wrapper + LaunchAgent, load, start
agentvoice resident status     # launchd state, socket, active account
agentvoice resident restart    # kickstart onto a fresh balancer pick
agentvoice resident uninstall  # unload and remove the LaunchAgent
```

Because threads live in the resident, quitting the console hangs up the voice
session but leaves the orchestrator agent and any running workers intact; the
next `agentvoice` resumes the same thread and re-adopts the workers. `--fresh`
(or the `f` key) is the deliberate way to start over.

Logs live in `~/.local/state/agentvoice/resident/`: `resident.log` (the
app-server's stderr) and `pick.log` (each spawn's account pick and why).

## Configuration

`$XDG_CONFIG_HOME/agentvoice/server.json` (default `~/.config/…`).
Precedence: **CLI > file > default**. An option left unset is not sent to codex
at all, so your `~/.codex/config.toml` applies — the defaults add no opinions
of their own. The console reads the file at start; the resident's wrapper
reads it at every spawn.

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
the realtime surface is experimental upstream. The start-only `threadSource`
is the exception: AgentVoice owns its orchestrator/worker labels so inventory
cannot be made ambiguous by configuration. Beware: upstream ignores
unknown fields rather than rejecting them, so a typo in `extra:` is silently
dropped — verify against a `--debug` trace when a knob seems dead. (The same
applies inside `config` and `extra` to the JSON Schema: it declares them as
free-form objects, so editor validation ends at their boundary.)

`voice.name` is the only live-watched key. A valid change redials only the
realtime voice session; the console, attachment, and orchestrator thread stay
in place. Invalid, unchanged, and unrelated edits are ignored for live
reaction. Every other config key remains boot-time configuration.

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
console shows the prompt count in its session panel.

Two cautions. `ORCHESTRATOR_BASE.md` replaces codex's *entire* system prompt
including its tool discipline — the console warns at boot when it is present
(it also silently disables `orchestrator.personality`). And while
`ORCHESTRATOR_SESSION_START.md` rides on **every** redial, codex delivers it
to the orchestrator only when a voice session actually opens after being
closed — not on renewals — and repeats it after every context compaction
while a session is live, so keep it short. Details and verified semantics:
[the field guide](docs/field-guide.md).

### Worker dispatch

`orchestrator.dispatch: true` declares three dynamic tools on the
orchestrator's thread — `dispatch_worker`, `check_workers`, `cancel_worker` —
answered by the console. A dispatched worker is a sibling codex thread with
its own context: it inherits the orchestrator's execution posture (sandbox,
approvals, model, `config:` layer) but no prompt files and no dispatch tools.
The orchestrator's turn ends immediately with a speakable handle (`w1`).

Workers live in the resident, so they keep running while the console is away.
The console persists its registry and reconciles on attach: still-running
workers are re-adopted (their completions flow again), turns that finished
while detached publish their reports from thread history, and a turn left
waiting on a dead console's tool answer is interrupted. Only a resident
restart makes a worker `lost`.

The console owns each worker thread before starting its turn, then retires it
after the terminal outcome has supplied the status and final message.
Materialized workers are archived — history remains listable, while the live
thread and its MCP/runtime resources shut down immediately. A thread whose
first turn is definitively rejected is deleted; ambiguous response loss is
archived so possible history is never erased. Cleanup retries independently
without changing the worker's visible outcome. AgentVoice tags orchestrator
and worker threads as `agentvoice-orchestrator` and `agentvoice-worker` in
Codex's `threadSource` metadata for durable inventory.

Completion has two modes, and the tool descriptions promise whichever one is
on. The default is **pull-only**: nothing is pushed when a worker finishes;
`check_workers` reads status and results. `orchestrator.dispatch-reports:
true` turns on the **evented** mode: the console starts a `<worker_report>`
turn on the orchestrator's thread carrying the status and the worker's final
message — upstream admission steers it into a running turn or opens a fresh
one, so reports land whether or not a conversation is mid-flight. Evented is
the mode a fire-and-forget doctrine is written against; it stays opt-in
because unprompted turns arriving at an unprimed orchestrator are an opinion,
and the defaults here add none. Pairs with `agents.enabled: false` in
`orchestrator.config:`, which removes codex's own in-thread sub-agent tools
so the two surfaces never compete.

### Multi-account balancing

`accounts.balance: true` makes the resident's wrapper pick which ChatGPT
account each app-server spawn runs on, using live quota data. Selection is
delegated to `agentusage balance codex` (falling back to `codex-swap select`),
so the balancing algorithm, freshness rules, and focus policies live with the
quota observer rather than here; the pick maps by email onto an
**account profile** — a per-account `CODEX_HOME` under
`~/.local/state/agentvoice/accounts/<slug>/` holding its own `auth.json`
and private `app-server-control/`, while symlinking session/config state to the
canonical `~/.codex`. One shared session store is what lets the orchestrator
thread resume under any account.

```bash
agentvoice accounts add personal   # codex login --device-auth, per account
agentvoice accounts add work
agentvoice accounts list
```

Selection runs at every resident spawn (install, crash restarts, rotation).
When the active account crosses `accounts.switch-threshold` (default 95% of
either rate-limit window), the console rotates: at the next idle moment — no
voice session, no running turn, no live workers — it kickstarts the resident,
whose wrapper picks the next account, and reattaches to the same orchestrator
thread.

Refusal posture: balancing on with codex-swap installed but **no profile
logged in is a configuration error — the console refuses to boot with the
exact `accounts add` commands** for the registered pool. Everything else
degrades: without the balancer CLIs the same config quietly runs the canonical
`~/.codex` (one config deploys to every machine), and transient refusals at a
spawn fall back loudly in `pick.log` for that spawn. With balancing off,
behavior is exactly the single-account default.

Two things this deliberately never does: copy credentials between stores
(ChatGPT refresh tokens rotate with reuse detection — each profile is its own
grant, logged in once, refreshed only by codex), and wrap the resident in
`codex-swap run` (its credential proxy swaps the model provider out from
under the realtime surface; see AGENTS.md invariant 10).

## Security posture

Nothing listens on the network. The resident serves a unix socket created
mode 0600 inside a 0700 directory; the console's control socket
(`console.sock`) is owner-only too — **file permissions are the boundary
between local users**, and there is no port for a browser or another machine
to probe. The console control socket doubles as the single-console lock: a
second `agentvoice` refuses to start while one is running.

That decides who reaches the agent; it cannot constrain what the agent then
does. Approval requests are always **auto-denied** (there is no UI to answer
them; the agent is told no and adapts instead of hanging), so the **sandbox is
the only real guardrail**. The default `danger-full-access` + `never` runs an
unattended, unrestricted agent with your user permissions in the workspace —
what makes hands-free "install it and run the tests" work. On untrusted
machines, prefer `--sandbox workspace-write`.

To control a session from another device, SSH in and use the
[Remote console](#phone-remote) — audio stays on the console's machine.

## The voice console

`agentvoice` attaches to the resident, resumes (or starts) the orchestrator
agent, and opens a full-duplex voice console. Capture and playback both run on
one client-owned miniaudio duplex device with bounded PCM rings; audio is
exchanged as Opus over WebRTC directly with the voice agent, and the console
renders live meters, sparklines, and finished-turn transcripts
(`you · …` / `agent · …`).

```bash
bun run console                                  # or: agentvoice
bun run src/main.ts --device 1 --debug
```

The device requests 48 kHz s16 mono capture and stereo playback from one
`ma_device_type_duplex`; miniaudio negotiates the physical device formats.
Playback holds a 500 ms playout cushion on start/rebuffer in a ring with 1 s
of capacity. Use `--output-device` to select a non-default speaker, or
`bun run audio:probe --device 1` to enumerate and briefly open the real duplex
device without starting a voice session.

The device is built from source and the console refuses to start without it —
`bun run setup` builds it, and `bun run native:build` rebuilds after editing
`src/console/native/`.

- **Keys**: `m` mute mic · `s` mute speaker · `r` redial voice · `f` fresh
  thread · `q` quit. Clicking the YOU panel toggles the mic; clicking AGENT
  toggles the speaker.
- **Redial** negotiates a fresh voice session against the same conversation
  while the old one keeps playing; audio swaps the moment the new session
  connects. It is the escape hatch when the media path dies silently. Renewal
  happens automatically before the ~60-minute upstream ceiling, using the same
  near-seamless swap.
- **Fresh** abandons the persisted orchestrator agent: the voice session ends,
  a new thread starts, and the console re-offers against it. Quitting never
  loses the conversation — only `f`/`--fresh` does, on purpose.
- **Headphones recommended**: there is no echo cancellation in this stack, so
  open speakers can let the agent hear itself. `s` is the manual guard.
- macOS microphone permission belongs to your **terminal app** (System
  Settings › Privacy & Security › Microphone, then fully restart it). If the
  mic delivers pure silence the console shows a warning naming this.
- `--debug` writes `~/.local/state/agentvoice/console-debug.log` including
  attachment protocol frames, audio-device inventory, decoded/playback
  cadence, physical device formats, callback cadence, RTP arrival-gap and
  handler-time distributions, ring occupancy, drops, callback-level starvation
  events, reroutes, and interruption counters, plus every upstream event.

### Phone remote

With the console running, SSH into its machine from a phone and open the
narrow Remote console:

```bash
ssh laptop
agentvoice remote
```

The console shows live `YOU` and `AGENT` activity rails and two large mute
controls for the microphone and speaker. It is designed around a portrait
terminal, while still adapting to other terminal sizes. Terminal mouse events
toggle the controls when the SSH app forwards them; `m` and `s` are the
keyboard equivalents, and `q` exits.

The Remote console connects to the voice console — not the resident — through
`~/.local/state/agentvoice/console.sock`, an owner-only Unix socket. It
carries only normalized levels, mute state, connection phase, and mute
assignments. Audio stays on the console's machine and needs no SSH
forwarding; for the intended setup, that machine's Bluetooth audio remains the
listening path. The Remote console waits and reconnects automatically when the
voice console is not running or restarts.

## State on disk

- `~/.local/state/agentvoice/workspace` — default orchestrator workspace.
  An `AGENTS.md` here reaches the orchestrator agent the ordinary codex way.
- `~/.local/state/agentvoice/app-server` — stable working directory for the
  resident (it re-reads its own cwd on every thread start; leave it in
  place). `$XDG_STATE_HOME` is honored.
- `~/.local/state/agentvoice/resident/` — the resident bundle (0700): the
  app-server unix socket, the rendered wrapper (`run.sh`), `resident.log`,
  `pick.log`, and `resident.json` (the active account pick).
- `~/.local/state/agentvoice/thread.json` — the persisted orchestrator
  threadId, resumed on attach. Delete it (or use `--fresh`) to start over.
- `~/.local/state/agentvoice/workers.json` — the persisted worker registry,
  reconciled against the resident on attach.
- `~/.local/state/agentvoice/console.sock` — ephemeral owner-only IPC between
  the running console and any local Remote consoles. It never carries audio.
- `~/.local/state/agentvoice/accounts/<slug>` — account profiles for
  multi-account balancing: a real `auth.json` and private app-server control
  directory per account, with session/config state symlinked to `~/.codex`.
  Safe to delete; recreate with
  `agentvoice accounts add`.
- `~/Library/LaunchAgents/com.agentvoice.resident.plist` — the resident's
  LaunchAgent, rendered by `agentvoice resident install`.
- `~/.config/agentvoice/` — `server.json` (with `server.schema.json` beside
  it for editor validation) and the prompt files beside it.

The orchestrator agent persists across console runs (`thread.json`); prompt
files are read at console start, so editing one takes effect on the next
`agentvoice`.
