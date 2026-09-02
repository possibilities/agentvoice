# AgentVoice Eval

Headless, multi-turn, full-duplex evaluation for coding voice agents. One
scenario drives three contenders—the real Codex App-server voice product,
Codex native voice paired with Fx, and a LiveKit voice agent paired with Fx—
with the same input audio, workspace, coding model, reasoning effort, oracle,
artifact contract, and quality rubric.

## Architecture

The reference contender keeps the product boundary intact:

```text
scripted lifelike evaluator audio
        ⇅ WebRTC
Codex App-server V3 voice agent (gpt-live-1-codex, cove)
        ⇅ built-in delegation and handoff
Codex App-server orchestrator (gpt-5.6-terra, medium)
        ⇅
isolated fixture workspace
```

The LiveKit contender separates the voice agent from the coding agent:

```text
scripted lifelike evaluator audio
        ⇅ local LiveKit RTC
LiveKit AgentSession + OpenAI Realtime voice agent
        │  gpt-realtime-2.1, medium, marin
        ⇅ asynchronous delegation and handoff
persistent Fx orchestrator (gpt-5.6-terra, medium)
        │  authenticated through the Codex subscription
        ⇅
isolated fixture workspace
```

The Codex–Fx contender keeps Codex's native voice behavior but replaces its
coding path with Fx:

```text
scripted lifelike evaluator audio
        ⇅ WebRTC
pinned Codex V3 voice sidecar (gpt-live-1-codex, cove)
        ⇅ client-managed delegation and speech handoffs
persistent Fx orchestrator (gpt-5.6-terra, medium)
        ⇅
isolated fixture workspace
```

The voice sidecar is a standalone `codex-app-server` built from one pinned
Codex revision and one small, hash-verified patch. With
`clientManagedHandoffs: true`, raw native delegation events remain visible to
the harness while both internal handoff routing and transcript-tail routing are
disabled. The harness sends each delegation to Fx's authenticated work-control
socket and returns progress or final results through
`thread/realtime/appendSpeech`. Validation fails if the sidecar starts even one
Codex coding turn.

LiveKit is the realtime conversation and media runtime; it does not replace the
coding orchestrator. The voice agent silently delegates checkout-specific work
to one persistent Fx process. Its first handoff makes the delegation
nonblocking, so the voice agent can keep listening and speaking. If the user
adds a constraint while Fx is working, another delegation calls Fx's
authenticated `work.steer` control surface against the active turn. Fx's final
result then arrives as a second, authoritative handoff for a concise spoken
report.

This is a product-baseline comparison, not a same-voice-model ablation. Codex
0.151.0 selects the private `gpt-live-1-codex` model internally and uses the
private `cove` default; neither can be selected through the public OpenAI
Realtime API. The LiveKit contender therefore uses the strongest explicit
public configuration tested here, `gpt-realtime-2.1` with `marin`. The coding
layer is aligned on `gpt-5.6-terra` at medium reasoning effort.

## Voice TUI

The bare-bones frontend: a terminal screen that dials the Codpiece voice
sidecar directly, owns the audio path, and routes the voice agent's
delegations to an orchestrator backend through the orchestrator adapter.
The microphone opens muted; hold Space to talk, or press `m` to toggle it.

```bash
bun run native:build                       # once per machine: the miniaudio duplex device
bun run tui -- --voice-sidecar PATH        # PATH is the sidecar binary; metadata.json sits beside it
bun run tui -- --voice-sidecar PATH --backend fx-work-control   # the PTY reference adapter
```

`--workspace` chooses where the orchestrator agent works (default: the
current directory); `--model`, `--effort`, and `--voice` override the Codex
reference defaults; `--mic`/`--speaker` pick device indexes; `--debug-log`
writes the event journal on exit. Keys: `m` mic, `s` speaker, `Space` hold
to talk, `r` redial, `q` quit. Holding `m` or `s` opens a muted channel for
the hold only; a quick press toggles it.

There is no acoustic echo cancellation yet — headphones are the honest
default when the speaker is live (ADR 0005 and the board record the
deferral). The sidecar proxies SDP and sideband only; audio flows peer to
peer between this process and the voice agent.

## Compact full-duplex scenario

The committed scenario packs four evaluator utterances into one conversation:

1. Diagnose an idempotency bug without changing code.
2. Implement the repair and regression tests.
3. Speak an exact-replay constraint while the agent is speaking and Fx turn two
   is still running; the constraint must steer that turn rather than replace it.
4. Run the entire suite and report the behavior, tests, and one remaining edge
   case.

A successful run must prove three genuine orchestrator turns, four delegations,
the third delegation steering turn two before completion, decoded audio overlap
during the steering utterance, and a 5/5 workspace oracle. Event waits are
semantic rather than fixed sleeps; completed-result waits allow 75 seconds so a
valid compact coding result is not rejected at the old 60-second boundary.

The four evaluator WAVs are selected, committed, and hash-locked. They were
rendered once with paid OpenAI `gpt-4o-mini-tts` using `marin` and a shared
natural-speech instruction. Normal evaluations reuse those exact bytes. See
`fixtures/compact-full-duplex/audio/README.md` for provenance and intentional
replacement rules.

## Requirements and cost boundaries

- Bun 1.3 or newer. Bun is the supported harness and LiveKit-worker runtime.
- `codex-cli 0.151.0` on `PATH`, already logged in.
- The local Fx fork on `PATH`, authenticated through the Codex subscription;
  the harness verifies that identity and its `yolo` permission mode before use.
- For the Codex–Fx contender, Git, Cargo, and a writable `/Volumes/Scratch` to
  build the pinned standalone voice sidecar. Its build is deliberately limited
  to two Cargo jobs, disables release LTO, and serializes release codegen for a
  16 GiB development machine.
- `livekit-server` on `PATH` (the accepted run used 1.13.6).
- `ffmpeg` and `ffprobe` on `PATH` for deterministic audio normalization and
  pairwise-judge media preparation and validation.
- A direct `OPENAI_API_KEY` for the LiveKit contender, optional text and audio
  judges, and intentional TTS replacement.

No LiveKit Cloud account, subscription, or credits are required. The harness
starts the open-source LiveKit server locally on loopback with ephemeral ports
and run-local development credentials. The current OpenAI Realtime path does
not use Vercel AI Gateway, so Vercel gateway credit does not replace the direct
OpenAI key for this contender.

Put the key in the ignored project-local `.env.local`, with mode `0600`:

```dotenv
OPENAI_API_KEY=your-key-here
```

The project-local value deliberately wins over an inherited shell value. The
key is passed only to the LiveKit/OpenAI voice worker or to an explicitly paid
TTS/judge command. It is removed from Codex App-server, Fx, and oracle
subprocess environments and redacted from persisted evidence.

Cost boundaries are intentionally visible:

- the Codex reference uses the Codex subscription for voice and coding;
- the Codex–Fx contender uses the Codex subscription for native voice and for
  Fx inference, but the voice sidecar itself starts zero Codex coding turns;
- the LiveKit contender uses the OpenAI API for realtime voice and the Codex
  subscription through Fx for coding;
- `render:fixture`, `judge`, and a live `judge:audio` comparison use the OpenAI
  API only when explicitly run; `judge:audio --prepare-only` and a complete,
  matching two-checkpoint replay make no model request;
- the local LiveKit lifecycle probe uses neither OpenAI nor a model.

## Install, probe, run, and judge

```bash
bun install
bun run test
bun run typecheck
bun run lint

# Uses a few seconds of Codex realtime quota but submits no coding turn.
bun run probe:codex

# Verifies the installed Fx identity and headless work-control surface.
bun run probe:fx

# Free local job/teardown probe. Bun is the supported worker runtime.
bun run probe:livekit -- --runtime bun

# Build and hash-bind the pinned native voice sidecar, then run it with Fx.
bun run check:codex-patch
bun run build:codex-app-server
bun run probe:codex-fx
bun run eval:codex-fx -- fixtures/compact-full-duplex/scenario.json

# Run the other contenders against the same committed scenario.
bun run eval:codex -- fixtures/compact-full-duplex/scenario.json
bun run eval:livekit -- fixtures/compact-full-duplex/scenario.json

# Text-only blind quality judgment: GPT-5.6 Sol, high reasoning by default.
bun run judge -- artifacts/<run-directory>

# Local preparation/validation of a listening bundle; no model request.
bun run judge:audio -- artifacts/<run-a> artifacts/<run-b> --prepare-only

# Paid, two-pass blind judgment with text evidence and all four audio tracks.
bun run judge:audio -- artifacts/<run-a> artifacts/<run-b>

# Optional paid replacement of one fixture utterance.
bun run render:fixture -- fixtures/compact-full-duplex/audio/tts.json --replace steer
```

The complete pairwise-audio syntax is:

```text
bun run judge:audio -- ARTIFACT_A ARTIFACT_B
  [--output FILE] [--media-dir DIRECTORY] [--model MODEL]
  [--timeout-ms MS] [--max-completion-tokens TOKENS]
  [--resume-pass-1 CHECKPOINT] [--resume-pass-2 CHECKPOINT] [--prepare-only]
```

The Codex runner fails closed unless the pinned App-server identity matches.
The Codex–Fx runner also verifies the sidecar source revision, source-patch
SHA-256, binary SHA-256, and reported version before starting voice or Fx.
The LiveKit runner fails closed unless the configured public voice identity and
Fx subscription identity match. Normal fixture use needs no TTS request.

## Artifacts and manual comparison

Every run writes a new immutable directory beneath ignored `artifacts/`:

```text
manifest.json
events.ndjson
input.wav
output.wav
comparison.wav
fixture-audio-receipt.json
workspace.patch
workspace-before/
workspace-after/
oracle.json
```

The Codex artifact also contains App-server stderr. The Codex–Fx artifact adds
the verified sidecar build identity, Fx terminal/stderr evidence, and copied
`scenario.json` plus `oracle.py` with SHA-256s in
`evaluation-input-receipt.json`; its event trace separately records the native
delegation, correlated Fx admission, and zero-Codex-turn proof. The LiveKit
artifact adds LiveKit worker/server logs and Fx terminal/stderr evidence.
`input.wav` and `output.wav` are 48 kHz mono;
`comparison.wav` is a duration-aligned 48 kHz stereo listening fixture with the
evaluator on the left and the agent on the right. That stereo WAV is the human
authority for timing, interruption, prosody, pronunciation, and artifacts.

LiveKit event evidence also records `voice.metrics.collected` for every
Realtime response and cumulative `voice.usage.updated` snapshots. These carry
the provider-reported text/audio and cached/uncached token splits needed to
price the voice-model portion of a run without estimating it from WAV duration.

The text judge writes a separate, write-once report beneath
`artifacts/judgments/`. It receives a blind allowlist of the manifest, canonical
events, oracle checks, and workspace patch, validates every citation, and
computes the weighted score locally. Audio bytes are intentionally withheld
from the text judge, leaving vocal delivery unscored and rubric coverage at
95%.

The pairwise audio judge first creates or revalidates a deterministic listening
bundle beneath `artifacts/judgments/media/`. Each candidate contributes a
full-length 96 kbps mono copy of `output.wav` for isolated vocal assessment and
a full-length 128 kbps stereo copy of `comparison.wav` for conversational
timing. The original PCM hashes and deterministic signal measurements remain
separate authorities. `--prepare-only` performs this entire media step without
an API request.

Without `--prepare-only`, the command sends both candidates' two complete
tracks plus anonymous text evidence to
[`gpt-audio-1.5`](https://developers.openai.com/api/docs/models/gpt-audio-1.5)
through Chat Completions. It runs two counterbalanced passes with A/B reversed,
sets `store: false`, forces one structured comparison call, validates every
evidence ID and audio timestamp, and computes both scores and the winner
locally. Product names, contender labels, artifact paths, and text identity are
withheld; acoustic identity is not masked and the report records that
limitation explicitly.

The default `blind-counterbalanced-dual-audio-v2` protocol binds each checkpoint
to the SHA-256 of the exact full JSON request under
`full-request-json-sha256-v1`. That binding covers the selected model, judge
instructions, forced-tool schema, anonymous evidence, and all four encoded
audio payloads without persisting the request or its audio bytes.

The v2 report also embeds the sanitized provider response and binds its exact
JSON with `sanitized-provider-response-json-sha256-v1`. Standalone validation
re-parses that response, checks its ID, model, finish reason, usage, and hash,
then reruns timestamp normalization to prove that the receipt is complete and
the normalized assessment came from the checkpointed provider output.

V2 audio observations explicitly name their track and use zero-based
milliseconds relative to that complete track. The validator accepts only two
restricted timestamp adjustments: a point citation is expanded by at most 500
milliseconds on either side, and an end time no more than 50 milliseconds past
the track may be clamped for encoder padding. Each adjustment records its exact
before/after interval; validation rejects false, duplicate, or overlapping
normalization claims. Reversed intervals, starts beyond the track, larger
overflows, missing citation arrays, invented evidence, and wrong-track citations
fail validation. V2 does not translate journal times, repair decimal-place
mistakes, or infer omitted citations.

Each paid provider response is checkpointed before semantic validation and
without request audio. Replay it with `--resume-pass-1 FILE` or
`--resume-pass-2 FILE`; the v2 protocol, request-binding version, ordinal,
label mapping, and full-request SHA-256 must all match. Supplying both matching
v2 checkpoints performs a local, credential-free replay. Supplying only one
still requires `OPENAI_API_KEY` for the other paid pass. Historical v1
checkpoints remain loadable for validation and audit but are validation-only
and cannot be replayed by v2.

Before media preparation or a provider call, every report-producing invocation
acquires an atomic `<output>.lock`; an existing report or competing lock fails
closed before spend. Reports, response checkpoints, and prepared media are
write-once. A normal live comparison makes two paid requests, and each request
contains all four full-length listening tracks.

## Accepted baseline

| Contender | Local artifact | Oracle | Quality | Full duplex |
|---|---|---:|---:|---:|
| Codex reference | `2026-08-30T15-02-52-325Z-compact-full-duplex-codex` | 5/5 | 92.6/100 | 3/4 |
| LiveKit + Fx | `2026-08-30T17-10-27-835Z-compact-full-duplex-livekit` | 5/5 | 92.1/100 | 4/4 |
| Codex–Fx | `2026-08-30T23-18-51-202Z-compact-full-duplex-codex-fx` | 5/5 | 96.1/100 | 4/4 |

The accepted Codex–Fx run contains four native voice delegations and four
correlated Fx admissions, with exactly three successful Fx turns (`1`, `2`,
and `4`). Delegation three steered active turn two before it completed, and
decoded PCM established 521 milliseconds of simultaneous evaluator and agent
speech. The complete post-teardown trace records seven native speech appends,
the workspace oracle passed all five checks, and the sidecar started zero Codex
coding turns. Its aligned recordings are 153.151 seconds long.

The Codex–Fx text judge awarded full marks for task outcome, steering fidelity,
full-duplex handling, flow, and latency. Its only deduction was that the reduced
judge evidence catalog did not expose the exact Fx test-command event, although
that event remains in the complete run trace.

The accepted paid audio-inclusive report is a historical
`blind-counterbalanced-dual-audio-v1` artifact. It predates v2's full-request
binding and restricted audio-time citation contract. Before retaining it, both
paid pass responses were manually and hash audited against their response IDs,
label mappings, v1 request-input hashes, source text-judgment hashes, and the
bound media manifest. Legacy report validation remains supported, but its v1
checkpoints cannot be replayed by the current protocol.

An adversarial review also found that the original local aggregate averaged
already-rounded pass totals. The corrected arithmetic averages the unrounded
weighted totals before the final one-decimal rounding; no paid pass was rerun,
and the provider responses, assessments, and usage are unchanged. The retained
result is:

| Contender | Overall | Audible experience | Vocal delivery | Active agent audio | Whole-timeline overlap |
|---|---:|---:|---:|---:|---:|
| Codex reference | 87.6/100 | 89.3/100 | 3.5/4 | 67.680 s | 0 s |
| Codex–Fx | 93.0/100 | 96.4/100 | 4.0/4 | 38.360 s | 1.145 s |

Codex–Fx is the locally aggregated winner by 5.4 points. Consensus remains
`mixed_with_tie`: the first pass called the runs tied, while the reversed-label
pass preferred Codex–Fx. Both received full marks for task outcome and steering
fidelity; the aggregate difference came from interruption handling,
conversational flow, responsiveness, and vocal delivery. Active duration and
whole-timeline overlap are descriptive PCM measurements, not additional score
components. The 1.145 seconds above spans the whole recording; the 521
milliseconds reported for the accepted Codex–Fx run is the narrower overlap
inside the required steering window. Both candidates had zero clipped samples
and zero click or dropout candidates.

The two accepted passes recorded 38,750 prompt tokens, of which 10,976 were
input-audio tokens, plus 6,036 completion tokens and zero output-audio tokens,
for 44,786 total tokens. Using the OpenAI prices listed on 2026-08-30 for
`gpt-audio-1.5`—$32 per million audio-input tokens, $2.50 per million
text-input tokens, and $10 per million text-output tokens—the accepted passes
estimate to approximately $0.481. This is a time-stamped estimate, not an
invoice: audio tokens are already a detail within the prompt total, and the
figure excludes discarded attempts, probes, account adjustments, and later
price changes. The billing dashboard and
[current OpenAI pricing](https://developers.openai.com/api/docs/pricing) are
authoritative.

This remains one scenario and two order-counterbalanced judgments, not a
general or statistically replicated superiority claim. `mixed_with_tie` is
evidence of a directional aggregate result, not unanimous judge consensus.

The earlier Codex reference and LiveKit runs both received full marks for task
outcome, instruction and steering fidelity, and spoken grounding. LiveKit
handled the overlapped steering turn better than the reference. Its 0.5-point
overall deficit came from one 6.069-second utterance-end-to-delegation delay and
unnatural speech of shell flags as repeated “dash” tokens. The accepted LiveKit
run has three Fx turns (`1`, `2`, `4`), four delegations, confirmed in-flight
steering, confirmed decoded-audio overlap, one matched job start/stop pair,
zero run or cleanup errors, and 214.866-second aligned
input/output/comparison recordings.

That accepted worker log contains three nonblocking timestamp-order warnings.
They came from a LiveKit `agent_config_update` marker whose logical position did
not match its wall-clock timestamp; OpenAI's adapter explicitly tolerates the
condition and all deterministic evidence passed. Current code retains the
marker in LiveKit's local history but removes it from a copied context before
OpenAI serialization. This keeps the unsupported marker out of provider-bound
history without rewriting LiveKit's local history; the adapter can still emit
its tolerated timestamp-order warning while reconciling that local history.

## Lifecycle and compatibility invariants

- Local LiveKit binds to loopback only and receives fresh random server API,
  room, and worker-control credentials for every run. The worker rejects job
  metadata unless both its run ID and workspace match the harness assignment.
- Worker shutdown uses an authenticated stdin control token. The job stops Fx,
  emits exactly one `livekit.job.stopped`, flushes telemetry, and only then lets
  the worker exit. A missing start/stop match fails the run.
- Fx is terminated as a process group, its authenticated Unix sockets live in a
  mode-0700 temporary directory, and cleanup removes that directory.
- OpenAI never sees LiveKit-only `agent_config_update` history markers. Filtering
  happens on a copy at the provider boundary, so LiveKit retains its full local
  history.
- Progress acknowledgments are at most eight spoken words; completed reports
  are at most 80 words and four sentences, with no spoken tool-call preamble.

The archived 0.147 stack used `gpt-live-1-boulder-alpha`, but that client is now
rejected by the service. It remains historical evidence rather than a runnable
baseline. Pinning Codex 0.151.0 is part of the reference identity because
App-server neither accepts an explicit private model override nor exposes the
selected private model on the wire.
