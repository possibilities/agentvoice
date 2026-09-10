# Desktop startup-context default

2026-09-08. Supersedes [ADR 0020](0020-native-launch-defaults.md) only for the generic voice startup-context
setting. The operator selected the inspected desktop-client baseline after
investigating an unsolicited repetition immediately after automatic renewal.

## Decision

At the realtime request boundary, send `includeStartupContext: false` unless
explicitly configured otherwise. Apply this on first calls, continue/resume,
redial and automatic renewal. Do not confuse the two defaults:

- **Desktop client:** its inspected startup helper explicitly selects false.
- **Stock app-server 0.153.4:** omission selects true for a new WebRTC call.

Named true/false values retain their meaning. Raw `voice.extra` merges last,
including `includeStartupContext: null` to restore native server resolution.
The config resolver keeps absence distinguishable from an explicit value;
`VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` still owns the startup-context slot and
forces true when present. Existing conflict checks remain intact.

Do not add reconnect instructions, speech replay, tail flushing, or changes to
the 52-minute timer. Working-thread history and ordinary delegation remain.
A new voice session no longer receives the generic working-thread/Recent Work/
workspace snapshot by default, so immediate voice recall can differ.

## Evidence and reproducibility

Inspected installed ChatGPT/Codex desktop **26.901.51231, build 8109**, reading
`Contents/Resources/app.asar`, not an original desktop source repository.
Asset: `webview/assets/app-initial-cadb12d4a15e.js`.
SHA-256: `73594359b28d81b6fcc9a52aac808f6a2e9fc32ced661adb3e23d297827b9285`.
Decoded JavaScript character offsets are useful anchors for this exact asset:

- Around 9376630–9377990, `USs` builds `thread/realtime/start`: the ordinary
  branch initializes `includeStartupContext:!1` before spreading explicit
  session overrides; the `existingCall` branch explicitly sends false.
- Around 4153016–4154200 and 9414740–9416270, remotely configurable continuity
  and memory settings control initial items. Continuity has a false fallback;
  when enabled with retained speech, it uses a continuity prompt containing a
  wait-for-new-input requirement. This change does not adopt those features.

Remote flags and effective account overrides were not observed. These findings
establish the shipped client baseline, not that every desktop session uses the
same configuration. Recheck the bundle after desktop upgrades; do not infer
client behavior from Rust omission defaults.

Stock source checked at `rust-v0.153.4`:
`codex-rs/app-server/src/request_processors/turn_processor.rs` defaults
`include_startup_context` to true for a newly created call;
`codex-rs/core/src/realtime_conversation.rs` builds the snapshot when enabled.
`codex-rs/core/src/context/world_state/realtime.rs` supplies backend start/end
steering on observed active-state transitions, not every session ID change.
Those messages do not independently trigger inference.

The observed incident had a completed answer, followed roughly fourteen minutes
later by timer-driven renewal and a newly generated paraphrase seconds after
connection. There was no intervening working-agent turn. Renewal issued only
`thread/realtime/start`, with startup context and tail flush omitted. This
supports the snapshot hypothesis but does not prove service-side causality.

## Validation and limits

Fake runtime tests cover fresh/resumed calls and repeated offers, asserting false
without history reads or turn submission. Override tests preserve true, false,
raw null, explicit initial items and the voice-append exception. These verify
request semantics, not live silence or recall. A controlled live renewal test
must still check unsolicited speech, follow-up recall and new work-result delivery.
Do not restart an active call to test this without current authorization.
