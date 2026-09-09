# Native Codex defaults and realtime contract

Read this before changing native launch settings, prompts, roles, realtime
session lifecycle, or the supported Codex version. The root
[ownership invariants](../AGENTS.md#ownership-and-state-invariants) still apply.
Paths written as code are relative to the repository root. Versioned observations
below describe the stated probes; recheck the relevant boundary on upgrades.
The [field guide](field-guide.md) retains the detailed audit evidence, and the
[decision log](adr/README.md) records policy changes.

## What vanilla Codex means

The default reference is the Codex client-and-server experience, including both
the voice frontend and working agent. AgentVoice replaces the frontend, so
matching that experience can require sending values that Codex's own client
sends. An explicit request field is not by itself an AgentVoice customization;
omitting it is not by itself vanilla behavior.

When auditing a default, trace the relevant Codex client's selection and the
app-server's resolution separately. Record versions, transport and any feature
gate or remote-config uncertainty; do not infer the active rollout from a
reachable source branch. Identify client parity, server fallback and deliberate
AgentVoice policy separately. New departures from that baseline need an explicit
product decision or operator configuration. Existing product policies remain
in effect until individually changed; this principle does not silently replace
them, clone all desktop internals or revive retired features.

For desktop voice choices, inspect the JavaScript bundled in the installed
app's `Contents/Resources/app.asar` alongside the public Codex server source.
The frontend assets may be minified/generated JavaScript; they are not a
desktop TypeScript source checkout in the CLI repo. Retain exact asset names
and bounded excerpts so client-default findings can be rechecked after updates.

Realtime v3 is the concrete example: the inspected desktop's client-owned-call
path explicitly selects it, while omitted WebRTC version on stock app-server
0.153.4 selects v1. Do not label v3 non-vanilla merely because it differs from
that server fallback. See [ADR 0019](adr/0019-client-server-default-baseline.md) and the field guide's default comparison audit.

## Upstream realtime semantics

Baseline lifecycle verified against Codex 0.147 source + probes. Version/default
and invalid-combination checks refreshed against stock 0.153.3 with network denied,
an isolated disposable CODEX_HOME, and deliberately invalid requests; no live audio.
On September 5, 2026, a live startup check with stock 0.153.3 and the local native
login rejected omitted WebRTC version with invalid_quicksilver_alpha_header;
explicit v3 connected (no microphone/speaker). See README's compatibility note.
The operator confirmed the v3 launch works and approved restoring it as AgentVoice's
documented WebRTC compatibility default. Desktop inspection on September 6 also
confirmed explicit v3 selection on its client-owned-call path; this is client
alignment, while the app-server's omitted-version fallback remains v1.

These invariants are load-bearing for `session.ts`; re-verify them before
bumping the supported codex version (`codex-rs/core/src/realtime_conversation.rs`,
`codex-rs/app-server/src/request_processors/turn_processor.rs`):

1. Three gates make the realtime surface work at all: spawn with
   `--enable realtime_conversation`, declare `experimentalApi: true` in
   `initialize`, and pass an explicit webrtc transport to
   `thread/realtime/start`.
2. app-server manages **one** realtime session per thread. A new start
   **supersedes** the previous session silently — no `closed` notification is
   emitted for it (renewal therefore never sends a stop).
3. `thread/realtime/stop` takes only `threadId` and always emits **exactly
   one** `closed(reason:"requested")`, even when no session exists. Ops on a
   thread are processed serially, so a stop issued after a start always lands
   after it.
4. `started` echoes the `realtimeSessionId` we chose; `closed` and `error`
   carry no session id. Natural end is `closed("transport_closed")`; failures
   emit `error` and then `closed("error")`.
5. A superseded session's WebRTC media path is not torn down promptly — the
   old peer lingers with a dead control plane. Clients must close it themselves
   (the console does, when the successor connects).
6. Priming is split across both calls, and not along agent lines. The
   orchestrator agent takes `baseInstructions` / `developerInstructions` on
   `thread/start`; the voice agent takes `prompt` on `thread/realtime/start`.
   But `realtimeStartInstructions` / `realtimeEndInstructions` also ride on the
   realtime call while being developer messages to the *orchestrator* — and
   they are therefore re-sent on every redial.
7. `prompt` is a double-option upstream: omitted keeps codex's built-in
   `backend_prompt.md`, while both `null` and `""` yield an empty prompt
   (`codex-rs/core/src/realtime_prompt.rs`). Prompt files encode that as
   absent vs. present with empty contents. A non-empty
   `experimental_realtime_ws_backend_prompt` in `~/.codex/config.toml` silently
   outranks the request `prompt`, and we cannot see it. There is no native
   append field: with includeStartupContext true, Codex renders `prompt`, a
   blank line, then `experimental_realtime_ws_startup_context` (or its Recent
   Work snapshot when that key is unset) — the only literal suffix path.
8. Thread and realtime params are serde-lenient: unknown fields are ignored,
   never rejected. A misspelled key in an `extra:` block fails silently, and
   `thread/resume` quietly drops start-only fields rather than erroring
   — hence `params.ts` filters known fields after the raw extra merge (0.153.3).
9. `initialItems` is realtime v3 only, capped at 128 items and 8,192 estimated
   text tokens. Require effective v3 for nonempty initial items. AgentVoice
   supplies v3 for WebRTC when version is unset;
   explicit voice.extra.version:null still reaches native fallback. In Codex
   0.153.3, that fallback selects v1 independently of general realtime config and
   ignores the native configured voice. Explicit v3 honors that voice config.
   WebRTC rejects v2; v1 and v3 use the same voice-name family. Do not infer
   that this transport default matches every Codex product UI.
10. The webrtc transport is load-bearing for auth, not just media: the
    websocket transport hard-requires an API key (`realtime_api_key`,
    `realtime_conversation.rs`), while webrtc authorizes the SDP POST and the
    sideband WebSocket with the ModelClient's ordinary bearer — which is what
    makes a ChatGPT login work here at all. The call URL derives from the
    session's model provider (`client.rs`, `REALTIME_CALLS_ENDPOINT`), so any
    provider-swapping wrapper (e.g. a localhost credential proxy) silently
    breaks realtime even when threads still work.

## Configuration and prompt rules

- Settings and prompt contents load once per runtime generation. No voice-name watcher or
  local catalog; Codex validates voice selection. Native identity and settings
  remain available through server diagnostics and read-only observation.
- server.schema.json is generated and drift-tested. server.json.example remains
  a verbatim-copy no-op. Unset fields are not sent, except explicit documented
  application defaults; do not imply the vanilla-defaults audit is complete.
  Keep protocol selection separate from prompt/model/context policy. An API fallback
  is not evidence of desktop parity. See the field guide's default comparison audit.
- codex-config is an optional string array; append repeatable -c/--codex-config
  CLI entries after file entries and pass each as a separate native -c argument
  after app-server. Never shell-evaluate, expand paths or log their values here.
  Native parses TOML, applies ordered dotted keys, and owns unknown-key behavior.
  Local interpretation covers explicit full-access overrides and required realtime
  guards. Preserve unrelated values verbatim. Startup values do not
  hot-reload or get copied into RPC config. Native request config can override
  startup entries; resumed model settings can outrank native startup defaults.
  The opt-in scripts/startup-config-probe.ts uses disposable state, network denial
  and ephemeral threads without turns/media to verify stock precedence on macOS.
- Prompt files are convention names in the selected config directory, not the
  workspace; absent means no override. Each name is one native control; do not add
  AgentVoice-shaped prompt overlays (the seed files were removed for that reason).
  Preserve empty contents and final raw extra precedence; a present name that
  cannot load fails before native startup even when extra would replace its value.
  Contents load once per runtime generation and are reused until explicit runtime
  replacement, never watched or copied
  between sessions. Legacy names and the retired prompt-files key are metadata-only
  warnings/errors, visible without debug; never silently delete/migrate user files.
  Removing overrides does not rewrite saved history or suppress native
  global/project instructions. A role directory replaces the config directory as
  the prompt source for its launch; config-directory files then warn, never merge.
- Do not manufacture skill policy, conversation summaries or speech-history
  replay. [ADR 0017](adr/0017-remove-spoken-history-replay.md) removes the automatic replay layer and its configuration.
  includeStartupContext defaults to false on every call, including renewal ([ADR 0029](adr/0029-desktop-startup-context.md) supersedes [ADR 0020](adr/0020-native-launch-defaults.md) for this setting). This matches inspected desktop-client
  JavaScript; the native server omission default is true. Explicit true requests
  the snapshot, false skips it, and raw null restores native resolution.
  Tail flush and experimental_realtime_ws_startup_context remain unset by default
  unless VOICE_AGENT_APPEND_SYSTEM_PROMPT.md claims the latter ([ADR 0013](adr/0013-convention-prompt-files.md)).
  Preserve explicit overrides; no user-config writes, forced tail-flush work,
  transcript database, or migration. Role skills are the only skill isolation:
  extra roots on the owned child, no global skills.config or plugin changes.
- Ordinary reconnects carry no AgentVoice-authored instruction or automatic
  initial items. Keep the native base prompt intact and preserve explicit native
  context/prompt overrides; no default tail-flush work or history rewriting.
  Native thread resume remains independent of new voice-call context.
  See [ADR 0017](adr/0017-remove-spoken-history-replay.md) for the removal decision and ADRs [0010](adr/0010-quiet-voice-resume.md)/[0011](adr/0011-spoken-history-continuity.md) for historical probes.
  Fake protocol tests do not establish live silence or audio-heard fidelity.
