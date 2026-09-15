# Current AgentVoice field guide

Updated for the waiting local server, explicit pointer frontend and web transcript
UI (ADRs [0024](adr/0024-server-and-pointer-frontend.md)/[0062](adr/0062-web-text-interaction-without-voice-attachment.md)/[0072](adr/0072-retire-terminal-composition-and-attachments.md)).
Historical upstream probes below retain their inspected versions and evidence.
References to in-call Fresh describe a retired UI control; restart remains in MCP/API.

## Architecture in a minute

```text
agentvoice frontend → private workspace socket → agentvoice server
  → retained workspace-session controller (leases, lifecycle control, read-only events)
    → disposable runtime → private native WebSocket → owned stock Codex child
      microphone/speaker ↔ miniaudio + Opus ↔ WebRTC ↔ voice service
      web Agent input / explicit speech → guarded gateway → private native WebSocket
```

The server never opens audio. If the selected workspace has a valid marker, server
startup immediately restores and pins its native runtime without a media owner.
Otherwise the first frontend lazily creates and pins one workspace session.
The frontend has static monochrome mute/PTT buttons and connection phase only.
Closing it releases holds and stops client media and realtime voice after an
acknowledged native stop; the controller, Codex child and native work remain.
A later sole frontend negotiates fresh media to the same session. A stop failure
has an unknown outcome and blocks media admission until server restart.
There are no keybindings or in-call Fresh. MCP/API redial and runtime restart
remain, including optional restart handoffs. Restart reloads the runtime under
the connected frontend and resumes the same thread. Guarded web input and explicit
handoffs use native turns.

Server launch flags select a canonical workspace and conversation policy. A valid
`.agentvoice-session` thread resumes at server startup; an absent marker leaves
thread creation to the first frontend. The retired `--continue` and `--resume` flags no longer select
history. Automatic WebRTC renewal keeps an attached frontend connected. Workspace
is a selection boundary, not a sandbox.

## Native gateway boundary probe

The host-side web composer and explicit speech helper use a guarded gateway
instead of receiving the owned Codex app-server credential. The retained security
probe demonstrates why a direct native credential is too broad:

```sh
CODEX_PATH=/absolute/path/to/stock/codex bun run scripts/attachment-boundary-probe.ts
```

The opt-in macOS probe uses disposable HOME/CODEX_HOME/workspace directories,
denies external network access, and starts no turns, inference, realtime sessions
or audio. Two protocol clients establish that the native bearer token itself can
change settings and create threads. Production therefore issues a short-lived
exact-controller/root ticket and permits only web Send/Steer/Interrupt plus the
explicit root speech operation. It rejects reads, settings, descendant navigation,
native questions and arbitrary method selection before native dispatch.

## Complete configurable surface

The generated server.schema.json is authoritative for spelling and types.

| Area | Keys / controls |
| --- | --- |
| Launch | optional --allow-full-access, workspace, config path, fresh/no-continue, resume ID, fast/no-fast, debug, microphone/output device indices, Codex executable |
| Main agent | model, effort, personality, native sandbox/approval modes, native approvals-reviewer, model-provider, service-tier, ephemeral, history-mode, runtime-workspace-roots |
| Native Codex config | orchestrator.config (including native experimental realtime config overrides) |
| Thread RPC escape hatch | orchestrator.extra; workspace and main source identity are protected, threadId/path/history are rejected |
| Voice | model, name, version, include-startup-context, delegation-ack-filler, codex-response-handoff-mode, codex-responses-as-items, codex-response-item-prefix, codex-response-handoff-channel-prefixes, flush-transcript-tail-on-session-end, client-managed-handoffs |
| Realtime RPC escape hatch | voice.extra; threadId/realtimeSessionId are rejected |
| Prompt files | Convention names beside the selected config: VOICE_AGENT_SYSTEM_PROMPT / VOICE_AGENT_APPEND_SYSTEM_PROMPT, VOICE_ORCHESTRATOR_SYSTEM_PROMPT / VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT, VOICE_ORCHESTRATOR_MULTI_AGENT_MODE, VOICE_ORCHESTRATOR_SESSION_START / _END (.md); one native control each, override and append exclusive per agent |
| Native startup config | codex-config array / repeatable -c or --codex-config key=value; TOML values, file then CLI entries, no defaults |
| Role | --role or the role key: a directory whose prompt files replace the config directory's, whose skills/ registers on the owned child, and whose mcp.json rides per-thread config |

Startup config belongs to the owned child, not its conversation requests. Later
orchestrator.config can override it; continue/resume may retain saved model/effort.
Use --model/--effort for explicit conversation changes. Named CLI settings beat
their named file counterparts, but raw extra fields merge later; explicit config
effort wins over --effort, and extra.config replaces the entire assembled object.
In Codex 0.153.3, an explicit effort request can also prevent saved model/provider
restoration on resume; specify the desired model when needed. Startup edits require a
relaunch, not Fresh. --config still selects AgentVoice JSON. Native paths inside
startup values are not rewritten; global native config is never edited by this feature.

Not every setting is a CLI flag: --help lists the common flags; server.json and
the passthrough objects expose the larger surface. Passthrough is not validation:
unknown native fields may be ignored, and unsupported transport/output values
can disable audio (visible launch warning). Known start-only fields are stripped
after raw resume merges; saved metadata still belongs to native history. --fast selects the working model's advertised native Fast
tier (higher usage/cost); --no-fast explicitly selects standard. Neither changes
the model, reasoning effort or realtime speech. With neither flag, tier/config
passthrough stays unchanged. The flags win over file/config/extra tier values;
Fast enables only the thread-local native feature gate, not global settings.
Support is checked against each child's catalog before work; unknown models,
missing tier metadata or a different per-thread provider fail clearly. Start/resume
responses confirm the applied setting when available. Native reported settings
remain distinct from requested settings; the frontend displays no tier label.

All AgentVoice settings and prompt contents load once per runtime generation. There is no
config watcher; voice-name edits take effect on the next explicit runtime replacement,
`new_session`, or server workspace session. Frontend reattachment does not reload
them. Prompts load from convention-named files in the selected config directory,
never the workspace; a present name that is unreadable, a directory or a broken
link fails before native startup. Former names only produce visible migration
warnings, with no content reads. Main prompt settings ride thread/start or resume;
session-boundary instructions and voice prompts ride each realtime start. The voice
append rides thread config as experimental_realtime_ws_startup_context plus
includeStartupContext true on each realtime start. Start-only native
metadata such as dynamic tools is persisted by Codex and cannot be removed merely
by omitting it on resume.

Voice protocol: AgentVoice selects v3 on final WebRTC requests with no version.
This frontend compatibility default aligns with the inspected desktop's newer
client-owned-call path. Stock app-server's omission fallback is a separate fact;
it does not by itself define the vanilla voice experience.
Explicit version overrides (including raw null) remain authoritative;
alternate raw transports receive no default. Raw initial items require effective
v3. A conflicting explicit protocol fails early.

On September 5, 2026, native WebRTC omission on stock 0.153.3 was rejected with
`invalid_quicksilver_alpha_header`; explicit v3 connected and the operator
confirmed it works. v3 also honors Codex's configured voice name; native WebRTC
omission ignores it. Speech-model resolution stays native to the chosen protocol.
See the [compatibility explanation](manual.md#webrtc-compatibility-default).
Retry exhaustion preserves the cause and stops after three failures; readiness
notifications do not bypass the retry delay.

## What ships versus what is native

AgentVoice supplies no default custom prompt files. Convention prompt files or raw
native prompt fields intentionally override behavior; VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md
maps to baseInstructions and replaces the full base prompt. Raw extra fields win
over files, including explicit null/empty values, except the startup-context slot,
which the voice append file owns outright. Unset sends nothing; a present empty
file sends empty text. Removing files does not erase saved instructions:
--no-continue tests a new conversation without changing native global/project guidance.
Global Codex configuration can itself override voice prompts or introduce
instructions, skills, MCPs and hooks. Removing deliberate AgentStart skill
injection does not isolate those native inputs.

Permissions defer to native/configured behavior when --allow-full-access is
absent. The flag explicitly selects danger-full-access/never and wins over
conflicting permission controls, including raw selectors. Native managed
requirements still apply. Restricted or missing permission reports do not stop
the child or prevent voice and web observation. Full access does not grant connector
consent or answer tool questions. Native approvals, tool questions and MCP
elicitations stay pending; AgentVoice reports but does not answer them. Unsupported
client requests still receive native denials or protocol errors with a visible
explanation.

Still application-owned: visible refusal handling, WebRTC/audio transport,
explicit continuation's workspace filters and renewal policy. These are not a
claim of complete desktop parity or support for every future native option.

## Default comparison audit

The reference for vanilla behavior is Codex's client-and-server experience,
including both voice and the working agent. Audit the relevant client's outgoing
choices alongside server fallback behavior; an explicit client-selected value
can be vanilla. Separate that alignment from deliberate AgentVoice policy and
operator customization. See [ADR 0019](adr/0019-client-server-default-baseline.md).

Rechecked September 5, 2026 against stock app-server 0.153.3 source and the
installed desktop client 26.831.20005 build 7524 (bundled Codex 0.152.0).
Desktop evidence is its shipped `webview/assets/app-initial-592a0643ed17.js`:
`bps` selects client-owned calls, `yfs` builds native requests, `Lhs` reads model
rollout configuration, and `Upr` builds its prompt/context settings. These are
reachable paths, not evidence of the operator's active rollout values.

Protocol selection rechecked September 6 against installed CLI 0.153.4 and the
same desktop build: `bps` explicitly selects v3 when the host is `durable`, or
the backend supports `threadRealtimeExistingCall` and gate `206132468` is enabled.
It then attaches the call with `transport: existingCall` and `version: v3`.
The other path uses WebRTC with dynamic-config overrides (`Lhs`, config
`3566525122`), whose version schema fallback is v1 but can receive another value.
The app-server forwards version unchanged; core selects v1 for omitted WebRTC
or existing-call version. This confirms a real desktop v3 path, not a universal
active rollout. These are Codex realtime protocol versions, not WebRTC standard
versions. The decisions below incorporate the September 6 defaults review
implemented in [ADR 0020](adr/0020-native-launch-defaults.md); earlier ADR decisions remain historical evidence.

| Area | Finding and consequence | Decision |
| --- | --- | --- |
| Protocol, speech model and voice name | Desktop's conditional client-owned-call path explicitly selects v3; stock app-server WebRTC omission selects v1 and ignores configured voice. Protocol also changes the native speech-model fallback. | Current v3 behavior aligns with that desktop path and service compatibility; leave model/name resolution and explicit overrides native. Do not classify it as non-vanilla solely from server omission. |
| Voice prompt and result visibility | The stock voice prompt says the user can see the full backend interaction and treats visible output as the primary surface. AgentVoice shows connection phase and mute controls, without a native work transcript/result view. | Keep the prompt unmodified for now. A minimal view of native results is a product gap worth resolving; silence or short spoken summaries may otherwise hide useful output. |
| Session prompts and handoffs | Native Codex has voice start/end instructions and automatic handoff forwarding. Desktop adds its own session instructions/tools and can create calls itself. AgentVoice keeps Codex in charge of both the call and handoffs. | Keep native instructions and forwarding. Copying desktop instructions/tool metadata requires corresponding frontend handlers; it is not a compatibility prerequisite. |
| Startup context and transcript tail | App-server-created calls default to startup context on and tail flush off. Desktop requests startup context off and tail flush on, alongside its own prompt/initial-item/context machinery. | [ADR 0029](adr/0029-desktop-startup-context.md) now selects false on every call to match the inspected desktop startup baseline, superseding [ADR 0020](adr/0020-native-launch-defaults.md) for this setting. Explicit true/false and raw null remain; tail flush stays unset. This does not copy desktop continuity machinery. |
| Work model, effort, Fast and history | Resume can restore saved settings; history mode also depends on native thread-store capabilities. Desktop can supply product/rollout settings. An omitted field does not necessarily mean config.toml is consulted. | Keep native resolution and existing Fast checks. Correct schema claims that history simply inherits config and that ultra guarantees proactive subagents. |
| Microphone processing | Desktop requests browser microphone noise suppression. AgentVoice's native duplex PCM path has no echo cancellation/noise suppression stage. App-server cannot supply capture processing to a client-owned microphone. | Existing audio-quality limitation, not fixed by omission or by v3. Keep the headphones recommendation; assess audio processing with real use before adding DSP. |
| Selection, permissions and transport | AgentVoice supplies required realtime gates and WebRTC/audio fields; explicit continuation uses exact-workspace history filters. Stock 0.153.3 lists this third-party app-server client's threads as `vscode` and may omit `threadSource` from list rows, so selection queries `appServer` plus `vscode` and verifies candidates with `thread/read`. | Ordinary launch starts fresh; explicit continue/resume retain lookup checks. Permissions inherit native/configured behavior unless --allow-full-access is supplied. Keep required realtime transport plumbing; re-probe list/read metadata on native upgrades. |

Source anchors: [native version/model/voice resolution](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/realtime_conversation.rs#L1215),
[startup context, tail flush and handoff defaults](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/app-server/src/request_processors/turn_processor.rs#L1204),
[voice prompt's frontend assumptions](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/prompts/templates/realtime/backend_prompt.md#L13),
and [native thread creation/history selection](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/app-server/src/request_processors/thread_processor.rs#L1419).
The source-kind and missing-list-marker behavior above was confirmed with
initialize/list/read probes against the installed stock Codex 0.153.3; it is a
version-specific compatibility fact, not a general app-server contract.

The v3 regression and its configured-voice side effect were confirmed. A later
continuity report also confirmed unsolicited repetition after a correct resume:
the new call received the old answer in native startup context but no new user
message. Desktop contains its own silence instruction and optional transcript
continuity machinery; stock app-server does not supply those semantics.
[ADR 0010](adr/0010-quiet-voice-resume.md) records the evidence and the
quiet-resume instruction that briefly addressed it; [ADR 0011](adr/0011-spoken-history-continuity.md) added saved-speech
restoration. [ADR 0012](adr/0012-vanilla-voice-reconnects.md) then retired the
instruction. [ADR 0017](adr/0017-remove-spoken-history-replay.md) subsequently
removed automatic saved-speech replay entirely at that time.
[ADR 0066](adr/0066-same-thread-voice-continuity.md) briefly restored bounded speech;
[ADR 0074](adr/0074-fail-closed-voice-history.md) removed it after duplicate-work incidents. [ADR 0020](adr/0020-native-launch-defaults.md) separately restores native
startup-context resolution; [ADR 0029](adr/0029-desktop-startup-context.md) later selects the desktop false default. Neither restores AgentVoice replay.

## Native voice context levers retained

| Lever | Effect | Does not do |
| --- | --- | --- |
| voice.include-startup-context | Requests/skips the native startup snapshot supplied to the voice session | Erase the working agent's thread history or prevent later delegation/recall |
| orchestrator.config.experimental_realtime_ws_startup_context | Replaces that snapshot when startup context is enabled; an explicit empty string suppresses its text | Replace the voice system prompt or bypass include-startup-context=false |
| voice.flush-transcript-tail-on-session-end | Delivers leftover speech transcript text to the working agent at voice-session end; can trigger a turn | Replay it through an AgentVoice-managed next-session buffer |

Decision ([ADR 0029](adr/0029-desktop-startup-context.md), superseding [ADR 0020](adr/0020-native-launch-defaults.md) for this setting): send false by default
on every voice start, including renewal. Desktop-client defaults and app-server
omission defaults differ: the latter includes the snapshot. Explicit true/false
request or skip it; raw null restores native server resolution.
Native tail flush and startup-text overrides stay unset by default.
Global/workspace instructions still apply.

AgentVoice supplies no automatic saved-speech initial items. Native thread resume,
private read-only transcripts and explicit prompt/config customization remain
unchanged ([ADR 0074](adr/0074-fail-closed-voice-history.md)).

The former `voice.replay-spoken-history` key is retired ([ADR 0017](adr/0017-remove-spoken-history-replay.md)), alongside
`voice.quiet-resume` ([ADR 0012](adr/0012-vanilla-voice-reconnects.md)). Remove either key even when set to false; launch
errors provide removal guidance. There is no automatic migration or history
rewriting. The timeline reader, legacy rollout fallback, replay limits and
replay probe have been removed.

## Optional features still present

Authentication: native Codex login, credential storage and refresh. CODEX_HOME
passes through unchanged; Codex resolves its default when unset. AgentVoice
never selects accounts or reacts to quota updates by replacing its child.
An explicitly selected existing home supplies native configuration and history;
there is no app-managed cross-home migration or shared-state reconciliation.

TUI/media: static monochrome YOU/AGENT buttons and conditional pointer PTT,
connection phase, server-side device selection, Opus/WebRTC, automatic renewal
and optional debug metrics. Warnings appear in the server terminal. There is no
echo cancellation, transcript pane, animation, palette or application keybinding.

## Removed

Resident/launchd management; mirrored peers; phone/remote mode; pairing, identity/certificate management and network
discovery/listeners; Android packaging; global thread selection and worker
restart/adoption registry; active Herdr integration; deliberate AgentStart
skill enabling; custom worker dispatch/check/cancel, completion-report turns,
registry, archival retries and UI callbacks; account selection/balancer calls,
profile creation/reconciliation, account commands/probe and idle quota rotation.
Native history and private legacy state are untouched. Retired dispatch config
keys error even when false. Old
tool definitions persisted by Codex may remain on resume: those calls fail with
a server-terminal retirement notice. New conversations start without them; nothing silently rewrites or
replaces a conversation. Native Codex tools/subagents/handoffs stay native.
Explicit raw dynamicTools metadata passes through on start with a visible warning,
without a client implementation; unknown dynamic calls receive protocol errors.
Client-managed handoffs and alternate raw media paths also warn; supported
baseline handoffs stay native. Voice-name hot reload and tap/hold classification
are removed. Pointer PTT is hold-only; channel clicks toggle persistent mute.

Retired accounts configuration errors even when empty or balance is false;
remove the entire section. Existing account-profile directories, credentials
and shared-state links remain untouched. Reusing one is an explicit CODEX_HOME
choice, not automatic discovery; see README migration notes.

## Deferred requests and decisions

- Native passthrough now covers startup, conversation and realtime settings;
  optional full access, fresh ordinary launch, WebRTC v3 compatibility and
  explicit file/session-boundary overrides are implemented. Startup context and
  other native context controls remain unset. This is
  not a claim that every native capability has a matching TUI or is independently verified.
- Selective seeding of global skills. Role skills are isolated to the owned child
  through `skills/extraRoots/set` ([ADR 0014](adr/0014-roles.md)); enabling or hiding globally
  installed skills per launch remains a native `skills.config` passthrough.
- Spoken conversation and audio latency/buffering validation. The editable command
  has been installed; stock 0.153.3 WebRTC startup has been checked without audio
  hardware, and the operator confirmed the v3 launch works. Broader audio quality
  and native tool/result presentation still need use-case validation.

Explicit continue/workspace selection, retained controller plus disposable
runtime ([ADR 0015](adr/0015-retain-controller-replace-runtime.md)),
and native --fast/--no-fast are implemented. They do not settle the items above.

Native readiness checks complete before audio hardware opens; negotiation waits
for audio readiness. LIVE is a media state, not work completion. Live audio and
latency/buffering remain separate checks.
