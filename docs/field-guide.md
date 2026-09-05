# Current AgentVoice field guide

Updated for the foreground/workspace design (ADR 0009). This replaces the
resident/remote-era inventory; that history remains available in Git and the
superseded ADRs.

## Architecture in a minute

```text
One AgentVoice process
  TUI and input → host → runtime → stock Codex child (stdio JSONL)
  microphone/speaker ↔ miniaudio + Opus ↔ WebRTC ↔ voice service
                                Codex owns native voice/work handoffs
```

The TUI does not run inference itself. The runtime selects a native Codex
conversation and negotiates voice; it supplies no worker tools or custom turns.
The child does tools and maintains history. Audio is a native library inside
the app, not another AgentVoice daemon.

Default launch continues this workspace's most recently updated eligible
AgentVoice main conversation. --no-continue creates one; --resume names one.
Fresh changes thread identity; redial changes only the realtime session.
Quit stops work. A workspace is a conversation-selection boundary, not a
security boundary or a guarantee against native memory of other work.

## Complete configurable surface

The generated server.schema.json is authoritative for spelling and types.

| Area | Keys / controls |
| --- | --- |
| Launch | mandatory --allow-full-access, workspace, config path, fresh/no-continue, resume ID, fast/no-fast, debug, microphone/output device indices, Codex executable |
| Main agent | model, effort, personality, fixed full-access/never posture, native approvals-reviewer (no execution approvals under never), model-provider, service-tier, ephemeral, history-mode, runtime-workspace-roots |
| Native Codex config | orchestrator.config (including native experimental realtime config overrides) |
| Thread RPC escape hatch | orchestrator.extra; workspace and main source identity are protected, threadId/path/history are rejected |
| Voice | model, name, version, include-startup-context, delegation-ack-filler, codex-response-handoff-mode, codex-responses-as-items, codex-response-item-prefix, codex-response-handoff-channel-prefixes, flush-transcript-tail-on-session-end, client-managed-handoffs |
| Realtime RPC escape hatch | voice.extra; threadId/realtimeSessionId are rejected |
| Prompt files | VOICE, ORCHESTRATOR, ORCHESTRATOR_BASE, ORCHESTRATOR_SESSION_START/END, VOICE_SEED_DEVELOPER/USER/ASSISTANT markdown |

Not every setting is a CLI flag: --help lists the common flags; server.json and
the passthrough objects expose the larger surface. Passthrough is not validation:
unknown native fields may be ignored, and unsupported transport/output values
can disable audio. --fast selects the working model's advertised native Fast
tier (higher usage/cost); --no-fast explicitly selects standard. Neither changes
the model, reasoning effort or realtime speech. With neither flag, tier/config
passthrough stays unchanged. The flags win over file/config/extra tier values;
Fast enables only the thread-local native feature gate, not global settings.
Support is checked against each child's catalog before work; unknown models,
missing tier metadata or a different per-thread provider fail clearly. Start/resume
responses confirm the applied setting when available; TUI labels missing data
as requested. The indicator is configured tier, not billing telemetry.

Only voice.name hot reloads. Prompts load once at launch and are reused on redial
and Fresh. Main prompt settings ride thread/start or resume; session-boundary
instructions and voice prompts/items ride each realtime start. Start-only native
metadata such as dynamic tools is persisted by Codex and cannot be removed merely
by omitting it on resume.

Voice protocol: unset voice.version stays off the wire. Stock Codex 0.153.3
uses v1 for WebRTC omission, independently of the general native realtime config;
it also ignores the native configured voice in that case, while an explicit
request voice still applies. This is the API's default, not necessarily every
Codex UI's choice. Explicit v3 preserves AgentVoice's former protocol and is
required for initial seed items. WebRTC v2 and non-v3 seed combinations fail
before child startup. Final extra overrides are checked; no seeds are silently
discarded and no protocol is auto-selected. Protocol changes may change the
default speech model/behavior. Current v1/v3 share a voice-name family.

## What ships versus what is native

AgentVoice supplies no default custom prompt files. Optional files intentionally
override native behavior; ORCHESTRATOR_BASE replaces the full base prompt.
Global Codex configuration can itself override voice prompts or introduce
instructions, skills, MCPs and hooks. Removing deliberate AgentStart skill
injection does not isolate those native inputs.

Full access is a deliberate exception to vanilla settings: every launch needs
--allow-full-access or errors before config/child/microphone startup. There is no
confirmation dialog or environment/config bypass; help is exempt and retired
commands report migration errors without launching.
Matching legacy permission values are accepted, incompatible typed/raw selectors
error, and the only supported profile is :danger-full-access. Native effective
dangerFullAccess/never must be verified on start/resume and Fresh.
Managed restrictions are never bypassed. A settings downgrade stops
the child. Full access does not grant connector consent or answer tool questions:
requests are refused through native denials or protocol errors with a persistent
TUI explanation, not an approval UI or invented answers.

Still application-owned: full-access-only posture, visible refusal handling,
WebRTC/audio transport, workspace-local selection and renewal policy. The project
is not yet fully vanilla in defaults, nor a complete passthrough for every future
Codex option.

## Native voice context levers retained

| Lever | Effect | Does not do |
| --- | --- | --- |
| voice.include-startup-context | Requests/skips the native startup snapshot supplied to the voice session | Erase the working agent's thread history or prevent later delegation/recall |
| orchestrator.config.experimental_realtime_ws_startup_context | Replaces that snapshot when startup context is enabled; an explicit empty string suppresses its text | Replace the voice system prompt or bypass include-startup-context=false |
| voice.flush-transcript-tail-on-session-end | Delivers leftover speech transcript text to the working agent at voice-session end; can trigger a turn | Replay it through an AgentVoice-managed next-session buffer |

Decision: keep all three configurable but unset; experience the native baseline
before tuning them. Omitted flags are omitted on the wire, including across
continue, explicit resume, redial and Fresh. AgentVoice does not populate a
startup override or rewrite native/user config. The upstream WebRTC behavior previously
verified here enables startup context and disables tail flush. Native startup
context can include recent work from other threads: workspace-local selection
is not memory isolation. Quit may interrupt tail-flush work; the app does not
wait for background completion. The README's optional examples are not shipped
configuration; remove a key to restore native resolution, not an empty/false value.

Static VOICE_SEED files are explicit operator-provided initial items, not a
transcript captured from the previous call. No AgentVoice transcript replay
layer was introduced.

## Optional features still present

Authentication: native Codex login, credential storage and refresh. CODEX_HOME
passes through unchanged; Codex resolves its default when unset. AgentVoice
never selects accounts or reacts to quota updates by replacing its child.
An explicitly selected existing home supplies native configuration and history;
there is no app-managed cross-home migration or shared-state reconciliation.

TUI/media: signal field, status/elapsed timer, working-model tier, dB meters, command palette,
mouse and keyboard mute/PTT, device selection, Opus/WebRTC, make-before-break
redial, automatic renewal and debug metrics. There is no echo cancellation,
text-chat transcript pane or interactive approval UI.

## Removed

Separate AgentVoice Server; resident/launchd management; control IPC and mirrored
peers; phone/remote mode; pairing, identity/certificate management and network
discovery/listeners; Android packaging; global thread selection and worker
restart/adoption registry; active Herdr integration; deliberate AgentStart
skill enabling; custom worker dispatch/check/cancel, completion-report turns,
registry, archival retries and UI callbacks; account selection/balancer calls,
profile creation/reconciliation, account commands/probe and idle quota rotation.
Native history and private legacy state are untouched. Retired dispatch config
keys error even when false. Old
tool definitions persisted by Codex may remain on resume: those calls fail with
a retirement notice. Fresh starts without them; nothing silently rewrites or
replaces a conversation. Native Codex tools/subagents/handoffs stay native.
Explicit raw dynamicTools metadata still passes through, without a client-side
implementation; unknown dynamic calls receive protocol errors.

Retired accounts configuration errors even when empty or balance is false;
remove the entire section. Existing account-profile directories, credentials
and shared-state links remain untouched. Reusing one is an explicit CODEX_HOME
choice, not automatic discovery; see README migration notes.

## Deferred requests and decisions

- Remaining vanilla-defaults and prompt/settings passthrough audit, particularly
  seed/session-boundary controls. Full-access-only and native protocol omission
  are decided and implemented.
- AgentVoice-specific skill isolation and selective seeding.
- AgentStart installation wiring and actual installation/first live voice use.
  Its current source installer has no AgentVoice entry; no install was run.

Continue/workspace selection, one foreground AgentVoice process (ADR 0009),
and native --fast/--no-fast are implemented. They do not settle the items above.

Workflow: one contextual sketch at a time, approval before implementation.
After each completed change, present the next sketch automatically until the
queue is exhausted; do not ask whether to reinventory.
