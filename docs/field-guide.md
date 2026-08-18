# The agent priming field guide

How to shape what the **voice agent** and the **orchestrator agent** know, how
they behave, and how they sound — every lever, its precedence, and its sharp
edges. Everything here is verified against **codex-cli 0.147.0** (the version
this repo pins): claims marked *(source)* were read out of the 0.147 source
tree; claims marked *(probe)* were exercised live against a real app-server on
ChatGPT-account auth. The realtime surface is experimental upstream, so
re-verify the load-bearing rows before trusting a newer codex.

Vocabulary is [`CONTEXT.md`](../CONTEXT.md)'s. Setup basics live in the
[README](../README.md); this guide is the depth behind its Configuration
section.

## The cast, and where behavior comes from

Three actors run every conversation:

- The **voice agent** — the realtime speech model you talk to. It holds the
  audio conversation, decides what to delegate, and relays results. It does no
  work itself.
- The **orchestrator agent** — the codex thread that does the work. It never
  hears audio; it receives delegations as ordinary user turns and answers
  through the voice agent.
- The **app-server** — the codex process (the launchd-kept **resident**) that
  owns both, performs the handoff between them, and applies almost every knob
  in this guide.

Four lifetimes decide how long anything you inject lasts — and they nest
differently than they used to, because the thread now *outlives* console runs:

```
thread                the orchestrator agent's identity and memory; persisted
                      (thread.json) and resumed by every console run until --fresh
 ├─ resident          launchd-kept app-server; a crash or rotation restarts it
 │                    and the console resumes the same thread
 ├─ console run       one `agentvoice console` process; prompts read at its start and
 │                    re-applied to the thread on attach
 └─ voice session     one WebRTC call; superseded by every redial
```

Behavior flows in through more channels than the config file suggests. In
rough precedence order (later rows are overridden by earlier ones where they
collide):

| Channel | Scope | Examples |
|---|---|---|
| CLI flags | console run | `--model`, `--voice`, `--effort` |
| `server.json` named keys | console run | everything in `server.schema.json` |
| Prompt files | console run (read at start) | `VOICE.md`, `ORCHESTRATOR.md`, seeds |
| `orchestrator.extra:` / `voice.extra:` | thread / voice session | any RPC field, merged last |
| `orchestrator.config:` | thread | raw config.toml overrides (SessionFlags layer) |
| `~/.codex/config.toml` | every codex on the machine | model, effort, MCP servers, hooks pointer, **three keys that outrank your prompts** |
| `~/.codex/AGENTS.override.md` / `AGENTS.md` | every thread | global user instructions |
| Workspace `AGENTS.md` chain | thread | per-workspace instructions |
| `~/.codex/hooks.json` | every turn | context injection, tool blocking |
| codex built-ins | — | system prompts, backend prompt, session-boundary texts |

Two consequences worth internalizing before touching anything:

- **An option you leave unset is not sent at all**, so the orchestrator
  inherits the machine's `~/.codex/config.toml`. If your daily codex runs
  `gpt-5.6-sol` at `max` effort, that is exactly what an unconfigured
  agentvoice orchestrator runs.
- **The machine's codex config can silently outrank your explicit settings**
  in three places (see [the three trump cards](#the-three-trump-cards)).

## The lever map

Every named lever, who it primes, when it applies, and where it lands on the
wire. `thread/start` fields ride once per thread; `thread/realtime/start`
fields ride on **every** voice session (renewal, recovery, manual `r`).

| Lever | Primes | Wire field | Applies |
|---|---|---|---|
| `orchestrator.model` / `--model` | orchestrator | `thread/start model` | per thread |
| `orchestrator.effort` / `--effort` | orchestrator | `config.model_reasoning_effort` | per thread |
| `orchestrator.personality` | orchestrator | `thread/start personality` | per thread (see [personality](#personality-a-lever-that-often-isnt)) |
| `orchestrator.workspace` | orchestrator | `thread/start cwd` | per thread |
| `orchestrator.sandbox` / `approval-policy` / `approvals-reviewer` / `permissions` | orchestrator | same-named fields | per thread |
| `orchestrator.model-provider` / `service-tier` / `ephemeral` / `history-mode` / `runtime-workspace-roots` | orchestrator | same-named fields | per thread (`ephemeral`, `history-mode` are start-only) |
| `orchestrator.config:` | orchestrator | `thread/start config{}` | per thread, any config.toml key |
| `orchestrator.dispatch` | orchestrator | `thread/start dynamicTools` | per thread (start-only; upstream restores tools on resume) |
| `orchestrator.dispatch-reports` | orchestrator | the tools' descriptions + pushed `turn/start` reports | per thread (default off: pull-only via `check_workers`) |
| `orchestrator.extra:` | orchestrator | merged into `thread/start` | per thread |
| `surface.events` / `socket` / `token` | the console | herdr `events.subscribe` + pushed `<surface_report>` turns | console lifetime (see [surface wakes](#surface-wakes-herdr)) |
| `ORCHESTRATOR_BASE.md` | orchestrator | `baseInstructions` | **every model request** (immune to compaction) |
| `ORCHESTRATOR.md` | orchestrator | `developerInstructions` | in-history developer item, re-injected after compaction |
| `ORCHESTRATOR_SESSION_START.md` / `_END.md` | orchestrator | `realtimeStartInstructions` / `realtimeEndInstructions` on the **realtime** call | on voice open/close **transitions** only (see below) |
| `VOICE.md` | voice | `prompt` | per voice session |
| `VOICE_SEED_*.md` | voice | `initialItems` | per voice session |
| `voice.model` | voice | `model` | per voice session |
| `voice.name` / `--voice` | voice | `voice` | per voice session (validated per version) |
| `voice.version` | both sides' protocol | `version` | per voice session (pinned `v3` by default) |
| `voice.include-startup-context` | voice | `includeStartupContext` | per voice session (default **on**) |
| `voice.delegation-ack-filler` | voice | `delegationAckFiller` | per voice session (upstream-defined filler) |
| `voice.codex-response-*` family | the handoff | same-named fields | per voice session |
| `voice.flush-transcript-tail-on-session-end` | the handoff | same-named field | per voice session |
| `voice.client-managed-handoffs` | the handoff | same-named field | per voice session (**sharp edge**) |
| `voice.extra:` | voice | merged into `thread/realtime/start` | per voice session (can override `outputModality`/`transport`) |

Prompt files have three states everywhere: **absent** (codex's built-in
stands), **present with content** (replace or append per file), **present but
empty** (the field is sent empty, stripping the built-in). Files are read at
console start — editing one takes effect on the next `agentvoice console`.

## The voice agent

### What you replace when you write VOICE.md

With no `VOICE.md`, the voice agent runs codex's bundled backend prompt
*(source: `prompts/templates/realtime/backend_prompt.md`)*. Its actual
content, condensed — this is the behavior you get by default and forfeit by
replacing:

- Identity: "You are Codex, an OpenAI general-purpose agentic assistant."
  Personality: "a playful collaborator: super fun, warm, witty, and
  expressive."
- It knows the user's first name — the built-in prompt templates
  `{{ user_first_name }}` from your OS account name. **Your replacement text
  gets no template expansion**; a literal `{{ user_first_name }}` in
  `VOICE.md` stays literal *(source)*.
- Delegation policy: "Pass execution work to the backend… **NEVER refuse
  requests. Delegate all user requests to the backend.** The backend makes the
  final judgement." Treat backend output as authoritative; never mention the
  word "backend"; present all work as your own.
- Presentation policy: don't read tables, diffs, or code blocks aloud; give
  the key takeaway; route reformatting requests back to the backend.
- Style policy: no filler, no play-by-play, no announcing plans;
  verbosity/pacing preferences the user states are sticky for the whole task.

What replacing it does — and does not — change *(probe)*: a `VOICE.md` with a
pure persona and **zero delegation instructions** ("You are Pegleg, a cheerful
pirate…") still delegated a spoken work request, the orchestrator still ran
the turn, and the file appeared in the workspace; the persona fully took
("Arr, hold fast, I'm on it…"), and chat-style questions were still answered
directly without delegating. In realtime v3 the delegation machinery is
**server-side wiring, not prompt obedience** — replacement changes tone,
judgment, and refusal policy, but cannot sever the handoff. What you *can*
lose is the presentation discipline (reading code aloud) and the
never-mention-the-backend illusion, so port the bullets you care about.

Stripping (`VOICE.md` present but empty) sends an empty prompt: the session
runs on the model's raw defaults plus whatever startup context injects.

### Seeds, greetings, and what a new session actually knows

Seed files become `initialItems`, which land in the session bootstrap next to
the instructions — capped at 128 items and 8,192 estimated text tokens (total
*and* per item), ~4 bytes ≈ 1 token, and violations are **hard errors** at
session start, not truncation *(source)*.

The truth about greetings *(probe)*: an assistant-role seed is **not spoken on
connect** — a fresh session is silent until the user speaks. The seed is real
history though: greeted with "what did you just tell me?", the agent quoted
its seeded line back as its own prior words. So `VOICE_SEED_ASSISTANT.md`
shapes the conversation's opening state, but an audible greeting needs the
user to speak first (upstream also has `thread/realtime/appendSpeech` — make
the agent say arbitrary text — which agentvoice does not currently
expose).

A fresh voice session is seeded with exactly three things *(source, probe)*:
the prompt (built-in or yours), the `<startup_context>` block, and your
`initialItems`. Nothing else crosses sessions — see
[memory](#voice-memory-across-sessions-the-startup-context).

### Voice memory across sessions: the startup context

`include-startup-context` (default **on**) appends a synthesized
`<startup_context>` block to the voice agent's instructions, opening with
"Startup context from Codex… may be incomplete or stale… do not repeat it
back unless relevant" *(source: `realtime_context.rs`)*. Sections and budgets:

| Section | Budget | Content |
|---|---|---|
| `## Current Thread` | 1,200 tokens (300/turn) | most recent turns of **this** thread, newest first |
| `## Recent Work` | 2,200 tokens | up to 40 recent threads across your machine, grouped by git project, first user ask of each (240 chars) |
| `## Machine / Workspace Map` | 1,600 tokens | cwd, git root, home; directory trees depth 2, 20 entries/dir, node_modules-class dirs skipped |
| `## Notes` | 300 tokens | fixed disclaimer |

This block is the **only** cross-session voice memory, and it works — with a
catch *(probe)*: a codeword told to the voice agent in session 1 was recalled
verbatim in session 2, **because** session 1 also delegated once and the
delegation's `<transcript_delta>` carried the utterance into thread history,
where the next session's Current Thread section picked it up. Voice-only chat
that never delegates **never reaches the thread** and is forgotten at session
end (default config; `flush-transcript-tail-on-session-end: true` is the
upstream rollout knob that routes the leftover tail through the orchestrator
at session end instead of dropping it). With `include-startup-context: false`
the next session answered "I do not know." — the switch cleanly zeroes voice
memory while the orchestrator keeps everything.

Two more properties worth knowing: the block is a **boot-time snapshot** —
compaction or new work mid-session never refreshes it — and `Recent Work`
leaks your machine-wide thread titles into every voice session; set
`include-startup-context: false` for demo/privacy contexts or an empty
workspace, or override the whole blob with the config.toml key below.

### Timbre, model, and version

`voice.version` is pinned `v3` by agentvoice (seed items are v3-only, and
every verified semantic in this guide is v3's). The three upstream versions
are effectively different products *(source)*: v1 (legacy bidi), v2 (the
OpenAI Realtime API shape — the only version supporting `outputModality:
text`, rejected over webrtc), v3 ("frameless bidi", server-side delegation).
Don't change `version` casually; v2 + this console's webrtc transport is
rejected upstream ("AVAS realtime calls require realtime v1 or v3").

**Voices are version-gated** *(source, probe)*: v3 accepts `cove` (default),
`juniper`, `maple`, `spruce`, `ember`, `vale`, `breeze`, `arbor`, `sol`.
`marin` — v2's default — is **rejected** under v3 at session start:
"realtime voice `marin` is not supported for v3". The full 19-name list in
older docs mixes both generations; under the pinned v3, only the nine above
start. Same per-session gate for `voice.model`: v3's upstream default is
`gpt-live-1-boulder-alpha` (v1/v2: `gpt-realtime-1.5`).

VAD, noise reduction, and the transcription model are **hardcoded per version
upstream** — no param or config key reaches them *(source)*.

### The handoff: how orchestrator output reaches the voice agent's ears

Everything the orchestrator streams back is appended into the voice session as
delegation context *(probe: `delegation.context.appended` frames)*. The mirror
is **thread-scoped, not delegation-scoped** *(source)*: while a session is
live, agent-message output from *any* turn on the thread — a client-started
turn included — is forwarded, and output with no delegation to attach to
flows as standalone-handoff frames through the same channel routing. That is
the mechanism that lets an injected report turn reach the voice agent's ears
(the basis for proactive announcements). Shaping:

- `codex-response-handoff-mode` — `thinking` (default): channel-less appends
  the voice model reads but isn't pushed to speak; `commentary`: everything
  lands on the commentary channel; `bemTags`: codex parses the orchestrator's
  own `[ANALYSIS]`/`[COMMENTARY]`/`[FINAL]` envelope and maps final →
  speakable, the rest → commentary (unparsable output defaults to speakable;
  the envelope text is left in) *(source)*.
- `codex-response-handoff-channel-prefixes` — renames those bracketed markers
  per BEM channel (`analysis`, `commentary`, `final`), each accepting a list
  of alternatives. Only meaningful with `bemTags`.
- `codex-responses-as-items` (+ `codex-response-item-prefix`) — delivers
  responses as conversation items instead of streamed appends; disables
  incremental streaming.
- Budgets you cannot raise *(source)*: orchestrator→voice text is capped at
  **1,000 estimated tokens per response**, streamed with a 200 ms flush
  cadence in 500-byte context-append chunks, head+tail truncated around
  "…output truncated…" beyond ~4,000 bytes. The voice agent summarizes long
  results by design; it never sees your full diff.
- `delegation-ack-filler` — v3's "one moment" acknowledgement while the
  orchestrator works. The filler behavior and text are upstream server-side;
  codex only passes the boolean through. Omitted keeps the upstream default.
- `client-managed-handoffs: true` — **sharp edge**: suppresses only the
  return path (delegations still route inward) and expects the console to
  deliver output via `appendText`/`appendSpeech`. This console never
  does, so this silently severs orchestrator→voice while letting the user
  keep asking for work *(source)*.

The user's side of the wire is visible to integrators: user speech transcripts
stream over the attachment as `thread/realtime/transcript/*` notifications
(webrtc mode included *(probe)*), and the console's data channel sees the same
conversation as v3 frames (`input_transcript.added`, `delegation.created`,
`turn.delta`, …).

### Session lifetime facts that shape priming

- The ~60-minute ceiling is **service-imposed**; codex 0.147 has no realtime
  timer at all *(source)*. Natural death is `closed("transport_closed")`.
- A new offer **supersedes** the running session silently; the superseded
  session's media lingers as a zombie until the console closes it. One
  upstream error frame on the control leg kills the codex side
  (`error` + `closed("error")`) while the media path keeps talking —
  delegations from a zombie session go nowhere *(probe, accidentally
  demonstrated)*.
- Because every `thread/realtime/start` re-sends the full voice priming, a
  renewal is also your only *(current)* way to change the voice agent's
  prompt/seeds/voice mid-conversation: edit files, restart the console, or
  wait — none apply to a live session.

## The orchestrator agent

### The instruction stack

From the bottom up, what the orchestrator's effective system prompt is made of
*(source)*:

1. **Catalog instructions template** for the model, with the
   [personality](#personality-a-lever-that-often-isnt) variant substituted.
2. `~/.codex/config.toml` `instructions` (rare) or `model_instructions_file`
   — wholesale replacements, machine-wide, discouraged upstream.
3. **`ORCHESTRATOR_BASE.md`** → `baseInstructions` — the top of the stack.
   Replaces *everything* above, including codex's tool discipline (the console
   warns at boot). It rides the API `instructions` field on **every** request,
   so it is immune to compaction — but it also **silently disables
   `personality:`** and the config-level replacements.

Alongside, as in-history items rather than the system prompt:

- **`ORCHESTRATOR.md`** → `developerInstructions` — a developer message in
  the thread's initial context. The sanctioned "house style" lever: append
  guidance without touching tool discipline. Re-injected with the full
  initial context after compaction.
- **AGENTS.md chain** — injected as a *user*-role message wrapped in
  `# AGENTS.md instructions … <INSTRUCTIONS>` *(source)*. Sources, in order:
  `~/.codex/AGENTS.override.md` else `~/.codex/AGENTS.md` (global, uncapped,
  first non-empty wins), then the workspace chain from project root down to
  the thread cwd (`AGENTS.override.md` beats `AGENTS.md` per directory;
  32 KiB total budget via `project_doc_max_bytes`, `0` disables;
  `project_doc_fallback_filenames` can add e.g. `CLAUDE.md`). Re-injected
  only when content changes, prefixed "These AGENTS.md instructions replace
  all previously provided…".
- **Session-boundary instructions** — see
  [below](#session-boundary-instructions-what-actually-fires-when).

### Personality: a lever that often isn't

`personality: none | friendly | pragmatic` substitutes a per-model variant
into the catalog instructions template at thread start; the effective default
is **pragmatic** (a stable feature flag, on by default) *(source)*. Three ways
it silently does nothing:

1. **The model doesn't support it.** The variant text lives in the model
   catalog; models whose entry has no personality variables ignore the
   setting entirely — and the *live* catalog is the one that counts, not the
   binary's bundled copy. Live probes found `friendly` real on both
   `gpt-5.6-sol` ("…a curious, rich personality") and `gpt-5.5` ("You have a
   vivid inner life as Codex…"), with `none` stripping the section on both —
   while the bundled catalog had claimed no support for the 5.6 family. The
   cheap verification for any model: ask the orchestrator whether its system
   instructions contain a `# Personality` section *(probe technique)*.
2. **You set `ORCHESTRATOR_BASE.md`** (or config-level `instructions`) —
   explicit base instructions skip template substitution wholesale.
3. **`features.personality = false`** in config.toml.

Mid-thread changes (upstream `thread/settings/update` — not exposed by
agentvoice) inject a `<personality_spec>` developer message instead of
rewriting the prompt *(source)*.

For the voice agent's mood, none of this applies — its personality lives in
`VOICE.md` (or the built-in "playful collaborator" line).

### Model, effort, verbosity, summaries

- `orchestrator.model` — mind the auth class *(probe)*: **`gpt-5.3-codex` is
  rejected on ChatGPT-account auth** ("The 'gpt-5.3-codex' model is not
  supported when using Codex with a ChatGPT account"), failing every turn
  with a `systemError` thread status while the voice agent cheerfully acks
  each request. If turns die instantly and the voice agent stalls after
  "I'm on it", check the resident log (`~/.local/state/agentvoice/resident/resident.log`)
  for this 400 first.
- `orchestrator.effort` — sugar for `config.model_reasoning_effort`
  (`none…ultra`); an explicit `config:` entry wins over the sugar. `ultra`
  additionally unlocks codex's proactive multi-agent behavior (the deprecated
  `multiAgentMode` is ignored in its favor) — moot under
  `agents.enabled: false`, which removes the spawn tools at any effort
  *(source)*.
- `model_verbosity` (config-only: `orchestrator.config: {model_verbosity:
  low|medium|high}`) — the Responses `text.verbosity` param; **silently
  ignored** (with only a codex-side warn log) when the model lacks verbosity
  support *(source)*.
- `model_reasoning_summary` (`auto|concise|detailed|none`) — how much
  reasoning summary streams; affects what transcripts/UIs show, not the work.

### Session-boundary instructions: what actually fires, when

`ORCHESTRATOR_SESSION_START.md` / `ORCHESTRATOR_SESSION_END.md` are developer
messages **to the orchestrator**, wrapped in `<realtime_conversation>` tags,
capped at 8,192 estimated tokens each (hard error beyond) *(source)*. Both
have **built-in defaults** when absent: codex tells the orchestrator "Realtime
conversation started. You are operating as a backend executor behind an
intermediary… treat user text as a transcript… keep responses concise and
action-oriented", and a matching "conversation ended, resume normal chat
behavior" on close. An **empty** file strips these; a non-empty file replaces
them.

Delivery is subtler than "on every redial" *(probe, correcting this repo's
earlier docs)*: the texts are rendered into the thread when a turn observes
the voice-session state **transition** —

- First turn while a session is open → the **start** text, once.
- A redial that supersedes a live session → **nothing** (state never left
  "open"; the superseding session's start text is never delivered, and the
  superseded session's end text never fires).
- Stop/close, then a turn → the **latest** session's end text.
- Compaction while a session is open → the start text is **restated** in the
  rebuilt context *(source)*.

Practical upshot: treat `ORCHESTRATOR_SESSION_START.md` as "the standing
briefing for voice mode", not a per-call event — it will not re-announce on
renewals, but it *will* be repeated after every compaction, so keep it short
anyway.

### Sandbox, approvals, and the guardian

Approval settings are behavior levers, not just safety rails. agentvoice
runs unattended and **fail-closes every approval request** — the orchestrator
is told "agentvoice runs unattended and never approves" and adapts rather
than hangs. Under the default `danger-full-access` + `never` nothing ever
asks; the sandbox is the only guardrail.

The interesting middle ground is upstream's **guardian**: `approvals-reviewer:
auto_review` routes approval requests to a dedicated read-only reviewer
subagent (catalog model `codex-auto-review`, 90 s timeout, fail-closed,
denial circuit breakers) instead of agentvoice *(source)*. Two rules decide
whether it does anything at all: the guardian engages **only under
`approval-policy: on-request`** (it is a no-op under `never`), and manual
re-approval flows don't exist here (no UI). The candidate recipe for a safer
unattended mode is therefore `sandbox: workspace-write` +
`approval-policy: on-request` + `approvals-reviewer: auto_review` — escalations
get AI adjudication instead of agentvoice's blanket denial.

Live-validated *(probe)*: an escalated write outside the sandbox was
**denied** under `approvals-reviewer: user` (the fail-closed default path)
and **reviewed and allowed** under `auto_review` — one
`item/autoApprovalReview` cycle, ~2.7 s, no client approval traffic. One
sandbox subtlety from the same probe: `/tmp` sits inside `workspace-write`'s
default writable roots, so "outside the workspace" is not automatically
"outside the sandbox" — escalations only trigger for genuinely protected
paths.

The workspace defaults to the user's home directory, which makes
`workspace-write` write-anything-you-own — nearly as wide as
`danger-full-access`. Pair it with an `orchestrator.workspace` narrowed to
the directory the work actually belongs in, or the mode buys nothing.

### Worker dispatch

`orchestrator.dispatch: true` is agentvoice's own lever on the surfaces
above: it declares `dispatch_worker` / `check_workers` / `cancel_worker` as
dynamic tools on the orchestrator's thread and answers their `item/tool/call`
requests itself. A worker is a sibling thread carrying the orchestrator's
execution posture (sandbox, approvals, model, `config:` layer) and none of
its prompts; its `turn/completed` payload carries the turn's items, final
message included *(probe)*. Completion is pull-only by default —
`check_workers` reads outcomes, and the tool descriptions say so. With
`orchestrator.dispatch-reports: true` the completion instead becomes a
`<worker_report>` turn started on the orchestrator's thread, which upstream
admission steers into a running turn or opens fresh *(source)* — and the
descriptions promise that instead, so the model-visible contract always
matches the wiring. While a voice session is live, a report turn's response
mirrors to the voice agent like any other output, which is what makes spoken
announcements of finished work possible. Workers live in the resident, so
they survive console restarts: the console re-adopts running workers on
attach and publishes reports for turns that finished while it was away; only
a resident restart makes a worker `lost` (never resumed). Disable codex's
in-thread sub-agents (`agents.enabled: false`) so the two dispatch surfaces
never compete.

Worker ownership begins after `thread/start` and before `turn/start`, closing
the fast-completion notification race. A terminal `turn/completed` is first
reduced into the public task outcome and report, then the worker root receives
`thread/archive`: upstream removes and shuts down the loaded session (MCP,
terminals, hooks, guardian runtime) before moving the rollout to archived
history *(source)*. Archival is idempotent and retries separately from the
outcome. If `turn/start` is definitively rejected, the empty root instead gets
`thread/delete`; timeout, malformed success, or lost transport are ambiguous
because core submits before app-server builds the response, so they archive
to preserve any materialized history *(source)*. Cancellation remains visibly
`cancelled`, but cleanup waits for the terminal notification so final output is
not lost. Account rotation also waits for cleanup to settle.

One upstream edge is normalized deliberately: deleting a never-materialized
thread shuts down its runtime before the store reports `no rollout found`.
AgentVoice treats that response as successful retirement; there is no history
file to preserve or delete *(source, probe)*.

Orchestrator roots carry `threadSource: "agentvoice-orchestrator"`; worker
roots carry `threadSource: "agentvoice-worker"`. These app-owned labels are
persisted scalar metadata for later inventory without heuristics *(source)*.

### Surface wakes (herdr)

Distinct from app-server worker threads: the fleet's orchestrator doctrine
also places workers on **the surface** — the shared runtime where coding
agents run in the open, watchable and joinable by the human; herdr is its
reference implementation. The orchestrator drives the surface itself through
the herdr CLI in its own thread (place, steer, read, attach); agentvoice's
only job is the wake wiring, and `surface.events: true` turns it on.

The console holds a long-lived `events.subscribe` NDJSON stream on herdr's
unix socket (`surface.socket`, default `$HERDR_SOCKET_PATH` else
`~/.config/herdr/herdr.sock`), watching the global pane lifecycle kinds.
Correlation is by pane metadata token: the doctrine has the orchestrator tag
each placed worker's pane (`herdr pane report-metadata --token
worker=<name>`; the key is `surface.token`), and only tagged panes wake. A
tagged worker that transitions to `blocked` (an approval or question UI) or
`done` (finished, unseen), or whose pane dies, becomes a `<surface_report>`
turn on the orchestrator's thread through the same fire-and-forget channel
as `<worker_report>` — steered into a running turn by upstream admission.
`idle`, `working`, and `unknown` never wake, and `unknown` does not update
the tracked state, so a screen-detection flap cannot re-arm a wake.

herdr replays nothing (its event hub is a small ring), so every (re)connect
reconciles against `agent.list` before trusting the stream: missed
transitions wake late rather than never, and a worker that vanished while
the console was away reports `gone`. Wakes that arrive while the console is
detached from the resident are dropped with a status line — the doctrine's
recovery is status on demand (`herdr agent list`), not a replay. One
fidelity caveat inherited from herdr: claude and codex panes are
screen-detected (their integrations report session identity only; pi is a
lifecycle authority), so `blocked`/`done` for those workers is a
classification, not a report.

### The ambient surface: MCP, skills, hooks, memory

The orchestrator inherits the machine's codex environment, which is easy to
forget when "configuring the agent":

- **MCP servers**: every `[mcp_servers]` entry in `~/.codex/config.toml`
  boots inside each thread — and gets used: a probe watched the orchestrator
  fulfill a file request through a globally-configured `node_repl` MCP server
  rather than its own exec tool *(probe)*. Disable per thread with
  `orchestrator.config: {orchestrator: {mcp: {enabled: false}}}` or prune the
  global list.
- **Skills**: same story via `orchestrator.skills.enabled` and
  `skills.include_instructions`.
- **Hooks** (`~/.codex/hooks.json`): fire on orchestrator turns under
  app-server — probes observed `sessionStart` and `userPromptSubmit` running
  synchronously on a delegation turn *(probe)*. A `UserPromptSubmit` hook's
  stdout becomes injected context and `PreToolUse` can block tool calls
  *(source)* — a machine-wide behavior channel that bypasses this repo's
  config entirely, and a latency tax when hook scripts are slow.
- **Web search**: the config default is `cached` — the orchestrator has a
  web-search tool unless you set `web_search: "disabled"` (or `live` for
  fresh results) in config.
- **Memory**: threads participate in codex's cross-thread memory feature
  (upstream `thread/memoryMode/set` toggles per thread; `memory/reset` wipes
  globally). agentvoice does not currently touch it, so whatever your
  codex-wide memory setting is applies to voice-driven work too.
- **Instruction-block toggles**: `include_environment_context`,
  `include_permissions_instructions`, `include_apps_instructions`,
  `include_collaboration_mode_instructions` (config keys, all default true)
  strip whole developer/user blocks from what the model sees — the nuclear
  option for a minimal-context orchestrator.

## Configuration plumbing

### Precedence, end to end

For any single knob the chain is: **CLI flag > `server.json` > (unset ⇒ not
sent) > `~/.codex/config.toml` > codex built-in**. Two layered subtleties:

- `orchestrator.config:` entries become a per-thread config layer that beats
  the user/project config.toml but **loses to typed `thread/start` fields**
  (so `orchestrator.model` beats a `config: {model: …}` entry) and to
  enterprise/managed requirement layers *(source)*.
- `extra:` blocks merge **last into the RPC params** — they can override
  anything agentvoice computed, including fields it owns (`outputModality`,
  `transport`, prompt fields). Powerful, unvalidated (see
  [leniency](#serde-leniency-typos-fail-silently)).

### The three trump cards

Three `~/.codex/config.toml` keys **beat this repo's own settings** and are
invisible to it *(source)*:

| config.toml key | Silently overrides |
|---|---|
| `experimental_realtime_ws_backend_prompt` | `VOICE.md` / the request `prompt` — highest precedence, non-empty wins |
| `experimental_realtime_ws_startup_context` | the synthesized `<startup_context>` (empty string disables injection entirely) |
| `experimental_realtime_start_instructions` | the built-in realtime-start text when no `ORCHESTRATOR_SESSION_START.md` is present |

If your `VOICE.md` seems inert, check the first row before anything else.

### Serde leniency: typos fail silently

Upstream deserialization ignores unknown fields on `thread/start` and
`thread/realtime/start`. Inside `extra:` (and any hand-rolled client), a
misspelled key is **dropped without an error**. The named keys in
`server.json` are validated by agentvoice; everything else is on you. When an
`extra:` knob seems dead, diff the `--debug` frame against the field tables in
this guide.

### Useful config.toml behavior keys (reachable via `orchestrator.config:`)

`model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`personality`, `developer_instructions` (config-level twin of
`ORCHESTRATOR.md`), `compact_prompt` (local compaction only — see below),
`model_auto_compact_token_limit` (+`_scope`), `tool_output_token_limit` (how
much tool output re-enters context), `project_doc_max_bytes`,
`project_doc_fallback_filenames`, `project_root_markers`, `web_search`,
`tools.request_user_input.enabled` / `tools.update_plan.enabled`,
`orchestrator.mcp.enabled` / `orchestrator.skills.enabled`,
`include_*_instructions` toggles, `features.*` (e.g. `token_budget` — a
no-summary context-rollover mode with model-visible reminder/guidance
templates), `agents.enabled` (**false removes the sub-agent spawn tools
entirely**, forcing the multi-agent version to disabled at any effort — the
hard form of "workers are app-server threads, not subagents" *(source)*),
`agents.max_concurrent_threads_per_session`, `agents.default_subagent_model`
/ `_reasoning_effort`, `notify` (turn-end argv hook, not model-visible;
fires with `{"type":"agent-turn-complete","turn-id":…}` — a callback
channel for out-of-process workers).

## Compaction

The orchestrator thread compacts; the voice agent never does (its session
context is managed upstream — probes see `session.context_window.rolled_over`
frames even in tiny sessions, none of it codex's doing).

**When**: at ~**90% of the model's context window**, checked before each turn
and mid-turn; `model_auto_compact_token_limit` can only *lower* the threshold
(values above the 90% derivation are clamped). Also on model switches that
shrink the window, and the model can request a fresh window itself via a
`new_context` tool *(source)*. Manual: upstream `thread/compact/start`
(fire-and-forget; emits `thread/compacted`).

**What survives, by mechanism** *(source)*:

| Material | Fate |
|---|---|
| `ORCHESTRATOR_BASE.md` (`baseInstructions`) | **Immune** — rides every request as the API `instructions` field, never in history |
| `ORCHESTRATOR.md`, AGENTS.md, environment/permissions blocks, realtime-start text | Deleted with history, **re-injected in full** on the next turn (mid-turn compaction splices immediately) |
| Recent user messages | Kept **verbatim**, newest-first, up to 20k tokens (local path) / 64k (remote path, the OpenAI default) |
| The first/oldest user message | **Not guaranteed** — oldest is dropped first when the budget runs out |
| Assistant messages | Local path: dropped; remote path: kept if small and non-final |
| Tool calls, tool output, reasoning | Always dropped |
| The summary | One user-role message (local) or one encrypted `Compaction` item (remote); prior summaries don't stack |

**Voice interplay** *(source + probe)*: the voice session is never notified
and survives; but its `<startup_context>` snapshot is now stale, and the
voice agent's sense of "what we were doing" silently diverges from the
orchestrator's compacted view. A voice utterance can itself trigger
compaction (delegations are ordinary turns). The realtime **start**
instructions are restated into the rebuilt context while a session is open —
the second reason to keep `ORCHESTRATOR_SESSION_START.md` short.

All of this ran live *(probe)*: a thread pinned to an 8,000-token compaction
limit compacted **five times** across four oversized turns while its voice
session stayed connected throughout; the rollout showed the developer
instructions re-injected and the `<realtime_conversation>` start text
restated after each compaction. One observability caveat from the same run:
the `thread/compacted` notification never fired (auto or manual) — if you
build tooling, watch for `ContextCompaction` thread items or the rollout's
`compacted` records instead, and note that `thread/tokenUsage/updated`
reports cumulative usage, not the live context size.

**Two traps**: `compact_prompt` customizes the *local* summarization prompt,
which OpenAI-auth users never hit (their compaction is remote V2);
and when a reattach resumes an over-limit thread, the first turn compacts
before doing anything else.

## Lifetimes, restarts, and what re-applies

| Event | Orchestrator thread | Voice session | Prompts/config |
|---|---|---|---|
| Voice redial (renewal, `r`, recovery) | unaffected — same thread | superseded silently; new session gets full voice priming again | voice-side files re-sent; session-start text **not** re-delivered (no transition) |
| Resident crash / rotation / upgrade | **resumed** — same thread id, history (compacted state included) restored from rollout; launchd restarts the resident, the console reattaches with backoff | died with the resident; the console sees `closed("app-server-detached")` and re-offers | `thread/resume` re-sends config + instructions; changed developer instructions only take effect if the resume point lacks a context anchor — in practice, unchanged (files are read at console start) |
| Console restart | **resumed** — the persisted threadId (`thread.json`) is the identity; running workers are re-adopted | gone (session lifetime is console lifetime); re-offered on start | prompt files re-read — this is when edits apply |
| `--fresh` / the `f` key | **fresh thread** — conversation memory gone; workspace files and rollouts remain on disk | torn down silently, re-offered against the new thread | full start priming applies to the new thread |
| Compaction | same thread, compressed model view; client-visible history unchanged | survives, unaware | base immune; developer/AGENTS re-injected |

The durable substrate across all of it: the **workspace** (files the
orchestrator wrote), `AGENTS.md` files, prompt files, and codex's rollout
files under `~/.codex/sessions/` (unless `ephemeral: true`). A `--fresh`
start begins a fresh agent brain in the same world — and its startup
context's "Recent Work" section will show the previous threads, which is the
one whisper of cross-thread continuity the voice agent gets for free.

## Gotchas

1. **`--voice marin` fails under the pinned v3** — "not supported for v3".
   v3 voices: cove, juniper, maple, spruce, ember, vale, breeze, arbor, sol
   *(probe)*.
2. **`gpt-5.3-codex` (and codex-branded models generally) can be rejected on
   ChatGPT-account auth** — every turn 400s while the voice agent keeps
   acking. Watch for `systemError` thread status *(probe)*.
3. **The three config.toml trump cards** override `VOICE.md`, startup
   context, and the session-start default invisibly *(source)*.
4. **`ORCHESTRATOR_BASE.md` disables `personality:`** and replaces codex's
   tool discipline; the console's boot warning is earned *(source)*.
5. **`personality:` is a no-op on models without catalog support** —
   including 0.147's bundled default `gpt-5.6-sol` *(source)*.
6. **`approvals-reviewer: auto_review` does nothing under `approval-policy:
   never`** — the default. Guardian needs `on-request` *(source)*.
7. **`client-managed-handoffs: true` silently severs orchestrator→voice**
   with this console *(source)*.
8. **Empty vs absent prompt files are different acts** — empty *strips* a
   built-in (including the session-start/end defaults you may not know
   exist); absent keeps it.
9. **Typos in `extra:` vanish silently** — serde-lenient upstream *(source)*.
10. **`initialItems` over budget is a hard session-start error**, not a trim
    (128 items / 8,192 tokens, ~4 bytes/token) *(source)*.
11. **Voice-only chat is amnesiac by default** — nothing reaches the thread
    without a delegation (or the tail-flush knob), so the next session can't
    remember it *(probe)*.
12. **The startup context leaks machine-wide thread history** into every
    voice session ("Recent Work", 40 threads) — mind demos on work machines
    *(source)*.
13. **Session-start text does not re-announce on renewals** — and *does*
    repeat after compaction *(probe/source)*.
14. **Global MCP servers, skills, and hooks ride along invisibly** — and get
    used *(probe)*.
15. **One malformed control frame kills the codex side of a voice session**
    while the media keeps playing — a zombie that hears and speaks but can't
    delegate. The console-side symptom: the agent stops doing work but keeps
    talking; redial *(probe)*.
16. **Editing prompt files does nothing until the next console start** —
    they're read once per run.

## Recipes

Each recipe names files in `~/.config/agentvoice/` (or your `--config`
directory).

**A different voice persona, delegation intact.** `VOICE.md` with your
persona + the delegation bullets you want to keep (steal from the built-in:
"pass execution work to the backend; never refuse; treat backend outputs as
authoritative; don't read code aloud; present work as your own"). Delegation
*mechanics* survive regardless *(probe)*; these lines preserve the *policy*
and presentation discipline.

**A greeting.** `VOICE_SEED_ASSISTANT.md` ("Welcome back! Ready when you
are.") — the agent treats it as something it already said and picks up from
there when the user speaks first. It is not auto-spoken *(probe)*.

**Terse voice, thorough orchestrator.** `VOICE.md`: "answer in one or two
spoken sentences; never enumerate; offer to go deeper." +
`ORCHESTRATOR.md`: "be exhaustive in written artifacts; the voice layer will
summarize." The 1,000-token handoff cap already forces summarization; this
makes it intentional.

**Localized voice.** `VOICE.md` in/about your language ("Speak German unless
spoken to in another language.") + `ORCHESTRATOR.md` for artifact language.
The transcription model is fixed upstream, but it handles major languages.

**Mood via seeds instead of prompt surgery.** Keep the built-in prompt
(delegation discipline intact), add `VOICE_SEED_DEVELOPER.md`: "Today's
register: dry, unhurried, zero exclamation marks." Seeds ride every session
and survive renewals.

**Safer unattended mode.** `orchestrator: {sandbox: workspace-write,
approval-policy: on-request, approvals-reviewer: auto_review}` — guardian
adjudication instead of blanket denial, live-validated: benign escalations
proceed after a ~3 s review; without the guardian they are denied outright
*(probe)*. Each escalation costs one guardian model call.

**A hermetic, quiet orchestrator.** `orchestrator.config: {orchestrator:
{mcp: {enabled: false}}, web_search: "disabled",
include_apps_instructions: false}` + `include-startup-context: false` on the
voice side: no ambient MCP tools, no web, no machine-history leak.

**Faster compaction for marathon sessions.**
`orchestrator.config: {model_auto_compact_token_limit: 60000}` — compact
early and often; base instructions are immune and developer/AGENTS text
re-injects, so priming survives. Accept that old tool output and the earliest
exchanges will be summarized away.

**Snapshot-free demos.** `--fresh` + `orchestrator: {ephemeral: true}` (no
rollout on disk, no resume after a resident restart) +
`include-startup-context: false` (no Recent Work leak).

## Upstream surfaces agentvoice does not (yet) expose

All verified present in 0.147's app-server protocol; each is a candidate
lever for a fork or a future version of agentvoice:

- `thread/inject_items` — append raw Responses API items to a thread's
  model-visible history **without starting a turn** *(source)*: the
  environmental-chatter channel. A worker report injected here waits
  silently until the orchestrator's next turn; note the snake_case wire
  name.
- `turn/start` on a busy thread **steers instead of failing** *(source)*:
  admission tries steer first, so input (plus `additionalContext`) merges
  into a running turn and only spawns a fresh turn when the thread is idle.
  Only review and compaction turns refuse steering — delegations are
  ordinary turns and accept it. `turn/steer` is the explicit
  add-to-running-turn verb (with an `expected_turn_id` precondition);
  `turn/interrupt` also exists.
- `turn/start.additionalContext` (also on steer) — client context fragments
  keyed by source id, typed `application` or `untrusted` *(source)*.
- `thread/start.dynamicTools` — client-implemented tools declared **at
  thread start** (thread-scoped, so later turns carry them); a model call
  comes back as an `item/tool/call` server→client request for the console
  to execute *(source, probe: full round trip)*. Delegation turns carry
  them too: the v3 delegation path submits through the same user-input
  admission as `turn/start` (`session/mod.rs
  route_realtime_text_input`) *(source)*. This is the surface
  `orchestrator.dispatch` rides.
- `thread/settings/update` — change model, effort, personality, sandbox,
  collaboration mode **mid-thread**.
- `thread/realtime/appendText` — inject silent context into a live voice
  session (role-tagged; the agent reads it but does not respond) *(probe)* —
  the natural "whisper events to the voice agent" channel.
- `thread/realtime/appendSpeech` — make the voice agent speak given text
  (true server-side greetings/announcements).
- `thread/realtime/appendAudio` — websocket-transport only; over webrtc every
  chunk bounces upstream while the RPC acks *(probe)*.
- `thread/goal/set|get|clear` — a thread objective with a token budget.
- `thread/memoryMode/set`, `memory/reset` — cross-thread memory control.
- `thread/compact/start` — manual compaction.
- `thread/fork`, `thread/rollback`, `turn/steer`.
- `turn/start additionalContext` / `dynamicTools` / `environments` — per-turn
  context fragments, client-defined tools, sticky environments (start-only).
- Notifications worth relaying to a richer client: `turn/started`,
  `turn/completed` (turn status `completed | interrupted | failed` — the
  push signal a worker-thread supervisor consumes), `thread/tokenUsage/
  updated`, `thread/compacted`, `item/*` progress, `hook/*`. Event
  streaming is per-thread and subscription-based upstream: a connection
  hears a thread once it has engaged it (start, resume, a turn, realtime
  start), which is also the attach path for monitoring a thread some other
  actor spawned *(source)*.
- Upstream control frames with no codex surface at all yet:
  `input_audio.pause`/`resume`, `session.feedback` *(probe: allowlist)*.

## Evidence appendix

Probes ran against codex-cli 0.147.0, ChatGPT-account auth, webrtc transport
(the production topology), driven headless: a werift peer with synthesized
speech (macOS `say` → Opus RTP), reading app-server notifications, the
client data channel, and thread rollout files as ground truth. Harness and
raw frame dumps: session scratchpad, `probes/`.

| # | Question | Result |
|---|---|---|
| P1 | `marin` under v3? | Rejected with the nine-voice allowlist |
| P2 | `appendText` conversational? | No — silent context append, both prompts |
| P2c/d | Does replacing `VOICE.md` sever delegation? | No — persona applied, delegation + file creation intact; direct questions still answered without delegating |
| P3 | Session-start text on renewal? | Not re-delivered on supersede; end text only for the latest session after stop |
| P4 | Cross-session voice memory? | Via delegation transcripts + startup context only; `include-startup-context: false` zeroes it |
| P5 | Compaction mid-voice-session | Five auto-compactions; session survived; developer + realtime-start text re-injected each time; `thread/compacted` notification never fired |
| P6 | Personality live on real models | `friendly` real on gpt-5.6-sol and gpt-5.5 (live catalog beats bundled); `none` strips; mid-thread `thread/settings/update` injects `<personality_spec>` |
| P7 | Guardian adjudication | user-reviewer: escalation denied; auto_review: reviewed ~2.7 s and allowed; `/tmp` is inside workspace-write's writable roots |
| P8 | Assistant seed spoken on connect? | No — history only; quoted back on request |
