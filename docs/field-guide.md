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
| Voice | model, name, version, quiet-resume and replay-spoken-history (frontend policies), include-startup-context, delegation-ack-filler, codex-response-handoff-mode, codex-responses-as-items, codex-response-item-prefix, codex-response-handoff-channel-prefixes, flush-transcript-tail-on-session-end, client-managed-handoffs |
| Realtime RPC escape hatch | voice.extra; threadId/realtimeSessionId are rejected |
| Prompt files | Convention names beside the selected config: VOICE_AGENT_SYSTEM_PROMPT / VOICE_AGENT_APPEND_SYSTEM_PROMPT, VOICE_ORCHESTRATOR_SYSTEM_PROMPT / VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT, VOICE_ORCHESTRATOR_SESSION_START / _END (.md); one native control each, override and append exclusive per agent |
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
responses confirm the applied setting when available; TUI labels missing data
as requested. The indicator is configured tier, not billing telemetry.

All AgentVoice settings and prompt contents load once at launch and are reused
on redial and Fresh. There is no config watcher; even voice-name edits need a
restart. Prompts load from convention-named files in the selected config directory,
never the workspace; a present name that is unreadable, a directory or a broken
link fails before native startup. Former names only produce visible migration
warnings, with no content reads. Main prompt settings ride thread/start or resume;
session-boundary instructions and voice prompts ride each realtime start. The voice
append rides thread config as experimental_realtime_ws_startup_context plus
includeStartupContext true on each realtime start. Start-only native
metadata such as dynamic tools is persisted by Codex and cannot be removed merely
by omitting it on resume.

Voice protocol: AgentVoice selects v3 on final WebRTC requests with no version.
This is a documented frontend compatibility default, not stock app-server's
fallback. Explicit version overrides (including raw null) remain authoritative;
alternate raw transports receive no default. Raw initial items require effective
v3. A conflicting explicit protocol fails early.

On September 5, 2026, native WebRTC omission on stock 0.153.3 was rejected with
`invalid_quicksilver_alpha_header`; explicit v3 connected and the operator
confirmed it works. v3 also honors Codex's configured voice name; native WebRTC
omission ignores it. Speech-model resolution stays native to the chosen protocol.
See the [compatibility explanation](../README.md#webrtc-compatibility-default).
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
WebRTC/audio transport, workspace-local selection, spoken-history replay, quiet-resume guidance and renewal policy. The project
is not yet fully vanilla in defaults, nor a complete passthrough for every future
Codex option.

## Default comparison audit

Rechecked September 5, 2026 against stock app-server 0.153.3 source and the
installed desktop client 26.831.20005 build 7524 (bundled Codex 0.152.0).
Desktop evidence is its shipped `webview/assets/app-initial-592a0643ed17.js`:
`bps` selects client-owned calls, `yfs` builds native requests, `Lhs` reads model
rollout configuration, and `Upr` builds its prompt/context settings. These are
reachable paths, not evidence of the operator's active rollout values.

| Area | Finding and consequence | Decision |
| --- | --- | --- |
| Protocol, speech model and voice name | Desktop can explicitly force v3; stock WebRTC omission instead selects v1 and ignores configured voice. Protocol also changes the native speech-model fallback. | Restore v3 compatibility in AgentVoice; leave model/name resolution and explicit overrides native. |
| Voice prompt and result visibility | The stock voice prompt says the user can see the full backend interaction and treats visible output as the primary surface. AgentVoice shows status and meters, without a native work transcript/result view. | Keep the prompt unmodified for now. A minimal view of native results is a product gap worth resolving; silence or short spoken summaries may otherwise hide useful output. |
| Session prompts and handoffs | Native Codex has voice start/end instructions and automatic handoff forwarding. Desktop adds its own session instructions/tools and can create calls itself. AgentVoice keeps Codex in charge of both the call and handoffs. | Keep native instructions and forwarding. Copying desktop instructions/tool metadata requires corresponding frontend handlers; it is not a compatibility prerequisite. |
| Startup context and transcript tail | App-server-created calls default to startup context on and tail flush off. Desktop requests startup context off and tail flush on, alongside its own prompt/initial-item/context machinery. | AgentVoice now defaults startup context off to avoid importing old topics into fresh conversations. Explicit true opts in. Tail flush remains unset; native defaults are not desktop parity. |
| Work model, effort, Fast and history | Resume can restore saved settings; history mode also depends on native thread-store capabilities. Desktop can supply product/rollout settings. An omitted field does not necessarily mean config.toml is consulted. | Keep native resolution and existing Fast checks. Correct schema claims that history simply inherits config and that ultra guarantees proactive subagents. |
| Microphone processing | Desktop requests browser microphone noise suppression. AgentVoice's native duplex PCM path has no echo cancellation/noise suppression stage. App-server cannot supply capture processing to a client-owned microphone. | Existing audio-quality limitation, not fixed by omission or by v3. Keep the headphones recommendation; assess audio processing with real use before adding DSP. |
| Selection, permissions and transport | AgentVoice supplies required realtime gates, WebRTC/audio fields, exact-workspace history filters, and full-access policy. Stock 0.153.3 lists this third-party app-server client's threads as `vscode` and may omit `threadSource` from list rows, so selection queries `appServer` plus `vscode` and verifies candidates with `thread/read`. | Keep these explicit choices: omitting them would change the product or break the client. Re-probe list/read metadata on native upgrades. |

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
[ADR 0010](adr/0010-quiet-voice-resume.md) records the evidence and the narrow
AgentVoice quiet-resume policy. That model instruction alone could not restore the last spoken reply. ADR 0011 adds actual saved-speech restoration; live acceptance still remains.

## Native voice context levers retained

| Lever | Effect | Does not do |
| --- | --- | --- |
| voice.include-startup-context | Requests/skips the native startup snapshot supplied to the voice session | Erase the working agent's thread history or prevent later delegation/recall |
| orchestrator.config.experimental_realtime_ws_startup_context | Replaces that snapshot when startup context is enabled; an explicit empty string suppresses its text | Replace the voice system prompt or bypass include-startup-context=false |
| voice.flush-transcript-tail-on-session-end | Delivers leftover speech transcript text to the working agent at voice-session end; can trigger a turn | Replay it through an AgentVoice-managed next-session buffer |

Decision (ADR 0011): default native startup context off on all calls, including
Fresh. Explicit voice.include-startup-context=true opts into the complete native
snapshot; raw null restores native resolution. Native tail flush and startup-text
overrides stay unset by default. Global/workspace instructions still apply.

Frontend settings are independent of those native controls:

| AgentVoice setting | Default | Effect |
| --- | --- | --- |
| voice.replay-spoken-history | true | Restore recent saved speech from the selected native thread on continue/resume/redial; false skips read/replay without changing working-thread continuation. |
| voice.quiet-resume | true | Ask the reconnected voice model to wait for new input; does not enforce silence in the transport. |

Neither key is forwarded as a similarly named RPC field. They build native v3
initialItems, keeping the native voice base prompt intact. Explicit raw initialItems
(including []/null) replace both automatic behaviors.
Fresh starts with neither; it never reads another conversation for speech replay.

Native timeline reads are preferred. Stock 0.153.4 rejects timeline reads for
legacy history; the fallback reads the verified local JSONL rollout returned by
thread/read, never a separate transcript database. It rejects unsupported shared,
forked, compressed or damaged fallback history rather than claiming recall.
Replay retains at most 64 speech segments and 24,000 UTF-8 bytes; the fallback scans
a bounded 8 MiB tail. Limits are visible, read errors stop that voice startup, and
replay-spoken-history=false is an explicit escape hatch. No history is rewritten.

## Optional features still present

Authentication: native Codex login, credential storage and refresh. CODEX_HOME
passes through unchanged; Codex resolves its default when unset. AgentVoice
never selects accounts or reacts to quota updates by replacing its child.
An explicitly selected existing home supplies native configuration and history;
there is no app-managed cross-home migration or shared-state reconciliation.

TUI/media: signal field, status/elapsed timer, working-model tier, dB meters, command palette,
conversation/workspace identity and native-reported model/effort/protocol,
visible media warnings, mouse and keyboard mute/PTT, device selection, Opus/WebRTC, make-before-break
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
Explicit raw dynamicTools metadata passes through on start with a visible warning,
without a client implementation; unknown dynamic calls receive protocol errors.
Client-managed handoffs and alternate raw media paths also warn; supported
baseline handoffs stay native. Voice-name hot reload and tap/hold classification
are removed: M/S toggle, Space and pointer PTT only hold.

Retired accounts configuration errors even when empty or balance is false;
remove the entire section. Existing account-profile directories, credentials
and shared-state links remain untouched. Reusing one is an explicit CODEX_HOME
choice, not automatic discovery; see README migration notes.

## Deferred requests and decisions

- Native passthrough now covers startup, conversation and realtime settings;
  full-access-only, WebRTC v3 compatibility, quiet-resume guidance and explicit-only
  file/session-boundary overrides are implemented. Startup context defaults off; other native context controls remain unset. This is
  not a claim that every native capability has a matching TUI or is independently verified.
- Selective seeding of global skills. Role skills are isolated to the owned child
  through `skills/extraRoots/set` (ADR 0013); enabling or hiding globally
  installed skills per launch remains a native `skills.config` passthrough.
- Spoken conversation and audio latency/buffering validation. The editable command
  has been installed; stock 0.153.3 WebRTC startup has been checked without audio
  hardware, and the operator confirmed the v3 launch works. Broader audio quality
  and native tool/result presentation still need use-case validation.

Continue/workspace selection, one foreground AgentVoice process (ADR 0009),
and native --fast/--no-fast are implemented. They do not settle the items above.

Native readiness checks complete before audio hardware opens; negotiation waits
for audio readiness. LIVE is a media state, not work completion. Live audio and
latency/buffering remain separate checks.
