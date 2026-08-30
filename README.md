# AgentVoice Eval

Headless, multi-turn, full-duplex evaluation for coding voice agents. One
scenario drives the real Codex App-server voice product and a LiveKit-based
contender with the same input audio, workspace, coding model, reasoning effort,
oracle, artifact contract, and quality rubric.

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
- `livekit-server` on `PATH` (the accepted run used 1.13.6).
- `ffmpeg` on `PATH` for deterministic 48 kHz mono PCM normalization.
- A direct `OPENAI_API_KEY` for the LiveKit contender, optional quality judge,
  and intentional TTS replacement.

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
- the LiveKit contender uses the OpenAI API for realtime voice and the Codex
  subscription through Fx for coding;
- `render:fixture` and `judge` use the OpenAI API only when explicitly run;
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

# Run both contenders against the same committed scenario.
bun run eval:codex -- fixtures/compact-full-duplex/scenario.json
bun run eval:livekit -- fixtures/compact-full-duplex/scenario.json

# Blind quality judgment: GPT-5.6 Sol, high reasoning effort by default.
bun run judge -- artifacts/<run-directory>

# Optional paid replacement of one fixture utterance.
bun run render:fixture -- fixtures/compact-full-duplex/audio/tts.json --replace steer
```

The Codex runner fails closed unless the pinned App-server identity matches.
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

The Codex artifact also contains App-server stderr. The LiveKit artifact adds
LiveKit worker/server logs and Fx terminal/stderr evidence. `input.wav` and
`output.wav` are 48 kHz mono; `comparison.wav` is a duration-aligned 48 kHz
stereo listening fixture with the evaluator on the left and the agent on the
right. That stereo WAV is the human authority for timing, interruption,
prosody, pronunciation, and artifacts.

LiveKit event evidence also records `voice.metrics.collected` for every
Realtime response and cumulative `voice.usage.updated` snapshots. These carry
the provider-reported text/audio and cached/uncached token splits needed to
price the voice-model portion of a run without estimating it from WAV duration.

The judge writes a separate, write-once report beneath
`artifacts/judgments/`. It receives a blind allowlist of the manifest, canonical
events, oracle checks, and workspace patch, validates every citation, and
computes the weighted score locally. Audio bytes are intentionally withheld
from the text judge, leaving vocal delivery unscored and rubric coverage at
95%.

## Accepted baseline

| Contender | Local artifact | Oracle | Quality | Full duplex |
|---|---|---:|---:|---:|
| Codex reference | `2026-08-30T15-02-52-325Z-compact-full-duplex-codex` | 5/5 | 92.6/100 | 3/4 |
| LiveKit + Fx | `2026-08-30T17-10-27-835Z-compact-full-duplex-livekit` | 5/5 | 92.1/100 | 4/4 |

Both received full marks for task outcome, instruction and steering fidelity,
and spoken grounding. LiveKit handled the overlapped steering turn better than
the reference. Its 0.5-point overall deficit came from one 6.069-second
utterance-end-to-delegation delay and unnatural speech of shell flags as
repeated “dash” tokens. The accepted LiveKit run has three Fx turns (`1`, `2`,
`4`), four delegations, confirmed in-flight steering, confirmed decoded-audio
overlap, one matched job start/stop pair, zero run or cleanup errors, and
214.866-second aligned input/output/comparison recordings.

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
