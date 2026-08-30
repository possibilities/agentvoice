# AgentVoice Eval

Headless, full-duplex evaluation harness for coding voice agents. The first
contender is the reference path already proven by the archived AgentVoice:

```text
scripted lifelike audio
        ⇅ WebRTC
Codex voice agent (V3, gpt-live-1-codex)
        ⇅ delegation/handoff inside App-server
Codex orchestrator agent (gpt-5.6-terra, medium)
        ⇅
isolated fixture workspace
```

The runner launches an ephemeral `codex app-server`, using the existing Codex
subscription and login. It does not need an OpenAI API key. WebRTC is
load-bearing: the App-server's websocket realtime transport requires an API
key, while WebRTC uses the ordinary Codex bearer.

The eventual LiveKit contender plugs into the same scenario and artifact
contract:

```text
scripted lifelike audio
        ⇅ LiveKit
LiveKit voice supervisor
        ⇅ ACP
Fx orchestrator agent (gpt-5.6-terra, medium)
```

## What is implemented first

- pinned Codex App-server 0.151.0 and its V3 default voice model,
  `gpt-live-1-codex`;
- explicit orchestrator model `gpt-5.6-terra`, reasoning effort `medium`;
- an action script that can play turns, wait on semantic events, sleep, and
  therefore barge in while either agent is speaking or working;
- raw App-server and realtime event logs with monotonic timestamps;
- separate user/agent WAVs and a stereo comparison WAV (user left, agent
  right) for human review;
- an isolated coding fixture plus a post-run oracle command.

The fixture's input WAVs are deliberately not committed. They will be rendered
by a paid, high-quality TTS provider so the automated run and demo use the same
lifelike audio. Until those are rendered, `probe:codex` verifies subscription,
the pinned version/model contract, signaling, and media-path access without
playing a test utterance.

## Requirements

- macOS or Linux with `bun` >= 1.3;
- `codex` 0.151.0 on `PATH`, already logged in;
- `ffmpeg` on `PATH` (normalizes fixture audio to 48 kHz mono PCM);
- a Codex account entitled to the experimental realtime surface.

```bash
bun install
bun run test
bun run typecheck

# Opens and closes a real V3 voice session. This uses a few seconds of realtime
# quota but does not submit a coding turn.
bun run probe:codex

# After fixture audio has been rendered:
bun run eval:codex -- fixtures/compact-full-duplex/scenario.json
```

Each run writes an immutable directory beneath `artifacts/` containing:

```text
manifest.json
events.ndjson
app-server.stderr.log
input.wav
output.wav
comparison.wav
workspace.patch
workspace-before/
workspace-after/
oracle.json
```

`comparison.wav` is the manual fixture: the scripted evaluator voice is on the
left channel and the agent is on the right. `events.ndjson`, workspace changes,
and `oracle.json` are the machine-judge evidence.

## Comparison doctrine

The two contenders share the scenario, audio bytes, workspace seed, coding
model, reasoning effort, permissions, and artifact schema. Transport-specific
events are preserved raw, then mapped to a small canonical vocabulary. Model
and voice identifiers are recorded together with how they were selected; the
harness fails closed rather than silently relabeling a private default.

The Codex reference intentionally keeps App-server's built-in voice prompt and
startup context. That is part of the product capability we are trying to match,
not noise to remove. A later controlled profile can disable startup context to
isolate the voice layer, but it should not replace the product-like baseline.

App-server selects the private V3 model internally: the Codex subscription
endpoint rejects an explicit `session.model`, and the Frameless
`session.started` event does not reveal the identifier. The harness therefore
pins Codex 0.151.0 as part of the reference identity and records model selection
as `app-server-v3-default`. The archived 0.147 stack used
`gpt-live-1-boulder-alpha`; that old client is retained locally for historical
evidence, but its live session is now rejected by the service and is not a
runnable baseline.
