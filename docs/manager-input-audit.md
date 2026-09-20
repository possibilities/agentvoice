# Manager input and injection audit

Audited 2026-09-20 against AgentVoice `88f48d1` and Codex source commit
`7498521d288b9b3b96ffba4eedf089d8d6e06a84`. “Manager” means the root Codex thread.
The destination column distinguishes model input from read-only transcript or
status projection.

| Source and file | Trigger | Destination | Purpose | Recommendation |
|---|---|---|---|---|
| Retired lifecycle completion bridge: former `src/completions/observer.ts`, `src/core/runtime.ts`, `src/runtime-control/{worker,controller}.ts` | A verified direct child's `turn/started`, `turn/completed`, status, or related lifecycle observation | Root `turn/start` with `turnTrigger: subagentCompletion` and a synthetic `agentvoice.subagent_completion` tool output | Wake or steer the manager with bounded lifecycle metadata | Removed. Native lifecycle must remain observation only. Do not reintroduce a wake, retry, summary, or synthesized tool output. |
| Native child result return: Codex `core/src/session/mod.rs::forward_child_completion_to_parent` and `core/src/agent/control.rs::send_inter_agent_communication` | A Multi-Agent V2 child reaches a terminal status with a report | Parent native input queue as `InterAgentCommunication`, `AgentCommunicationKind::Result`, `trigger_turn: false` | Deliver the authoritative worker result to its exact native parent | Preserve. This is the direct result path and is independent of AgentVoice lifecycle observation. It may wait for the parent's current or next turn. |
| Native lifecycle history: Codex `multi_agents_v2::emit_sub_agent_activity`; AgentVoice `src/events/conversation*.ts`, `web/server/live-reader.ts`, and `web/src/transcript-ui/**/codex-subagent-event.ts` | Spawn, interaction, interruption, or successful child completion | Native durable history, read-only event socket, and transcript card | Show exact historical activity without model, result, or Work claims | Preserve as observation. The card is not manager input and is not orphaned by retiring the bridge. |
| Human web composer: `web/server/agent-controls.ts`, `web/server/agent-sender.ts`, `src/attachment/{gateway,policy}.ts` | Explicit Send or Steer with human text/images | Exact root `turn/start` or `turn/steer` | Submit human-authored Agent input | Preserve. Keep exact root/turn fences, correlation IDs, and unknown-delivery handling. |
| Host queue drain: `web/server/agent-controls.ts::drain` | A human-created queued row becomes eligible after authoritative turn state changes | Exact root `turn/start`; an explicit queued Steer uses `turn/steer` | Deliver previously authorized human text/images in FIFO order | Preserve. It is delayed human input, not lifecycle-generated content. Never retry unknown delivery or create queue rows automatically. |
| Explicit speech helper: `scripts/voice-speak.ts` through the attachment gateway | Operator invokes the helper with text | Root `thread/realtime/appendSpeech` | Add explicit human speech text to the active realtime session | Preserve. Keep one attempt and surface native refusal. |
| Native realtime voice: `src/core/params.ts::realtimeParams`, `src/core/runtime.ts`, and the media host | An attached frontend starts or renews a voice session and the human speaks | Native `thread/realtime/start` plus WebRTC media; Codex owns voice-to-working-agent handoff | Run the voice agent and its native delegation to the manager | Preserve. `delegationAckFiller`, response handoff mode, channel prefixes, and session-boundary instructions are native configuration, not an AgentVoice lifecycle message. Keep `clientManagedHandoffs` discouraged because AgentVoice supplies no replacement forwarding. |
| Voice handoff presentation: `web/server/messages.ts::voiceDelegationInput` and `web/src/transcript-ui/**/codex-presentation.ts` | A native root `userMessage` matches Codex's realtime delegation wrapper | Read-only Human transcript row labeled `Via Voice` | Explain that ordinary native input originated with the voice agent | Preserve as presentation only. It parses no work/result identity and never resubmits the wrapper. |
| Restart handoff: `src/runtime-control/controller.ts::deliverHandoff`, `src/core/runtime.ts::submitHandoff` | An explicit restart request includes `handoffPrompt` and the replacement resumes the exact thread with live media | Root `turn/start` with labeled caller-provided text | Continue the caller's task across an intentional runtime restart | Preserve. It is explicitly requested, journaled before teardown, single-attempt, and reports accepted/failed/unknown separately. |
| Orchestrator prompt/config inputs: `src/core/config.ts`, `src/core/params.ts::threadParams`, role prompt files | New thread or exact resume loads configured role and prompt controls | Native `thread/start`/`thread/resume` base instructions, developer instructions, multi-agent mode, MCP config | Configure the manager rather than inject runtime lifecycle content | Preserve. Keep one owner per prompt slot and do not synthesize event-dependent prompts. |
| Realtime prompt/config inputs: `src/core/params.ts::realtimeParams` | Realtime start or renewal | Voice model prompt, startup context choice, session start/end instructions, optional explicit `initialItems` | Configure voice behavior and native handoff boundaries | Preserve. Explicit `initialItems` are operator configuration; saved speech is never converted into them. |
| Historical routing context: `web/src/transcript-ui/lib/api/routing-context.ts` and routing card tests | Native history contains a pre-retirement `agentusage.routing_context` output | Read-only transcript card | Explain old routing orientation already stored in history | Preserve historical parsing only. ADR 0099 removed polling, publication, query, and `turn/start` injection; do not create fresh routing input. |
| Native collaboration tools: Codex `spawn_agent`, `followup_task`, `send_message`, `wait_agent`, `interrupt_agent` | The manager explicitly calls a collaboration tool | Native child thread or exact recipient mailbox; `wait_agent` observes mailbox activity | Execute and communicate within Codex's native agent tree | Preserve. AgentVoice observes results and history but does not wrap, duplicate, or reinterpret these calls as manager input. |
| AgentVoice control MCP results: `src/control/`, `src/core/control-mcp.ts` | The manager explicitly calls an enabled `agentvoice_control` tool | Native MCP tool result in the requesting turn | Read status or execute explicit redial/restart/new-session/voice operations | Preserve as request/response. Tool output does not start another turn; optional restart handoff is the separately audited path above. |
| Native request refusal: `src/core/attach.ts` and `src/core/human-input.ts` | Codex asks AgentVoice to handle an unsupported client tool/auth request, or asks a human question | Error or failed tool output returned to the requesting native turn; human request remains pending | Fail closed without inventing approval or implementation | Preserve. The response is correlated to Codex's request and must never become an unsolicited prompt or automatic answer. |
| Conversation/history readers and AgentHUD export: `src/core/{thread-observer,conversation-reader}.ts`, `src/threads/` | Read-only inventory, exact history request, or `agentvoice threads --json` | Event clients and AgentHUD | Supply native identity, parentage, timing, and bounded content evidence | Preserve. These paths never submit, resume, steer, or bind Work themselves; exact Work/Assignment binding remains an AgentHUD responsibility. |
| System and recovery notices: controller/runtime `notice` fields, conversation gaps, and context-compaction cards | Local failure, incomplete observation, or native compaction | Frontend state or read-only transcript card | Tell the human about status/history without affecting the model | Preserve as display-only. Do not route notices back into Codex input. |
| Delegation policy probe: `scripts/delegation-policy-probe.ts` | An operator explicitly runs the diagnostic script | Its owned probe thread through `turn/start` | Measure native delegation behavior outside production server flow | Preserve as an explicit diagnostic. It is not imported by runtime code and must not become a startup or background producer. |

The only removed production input source is the lifecycle completion bridge. No
dedicated transcript card existed for its `agentvoice.subagent_completion` output;
generic historical tool output remains readable. Native `subAgentActivity`, context
compaction, and historical routing cards have distinct surviving sources.

## Evidence

- Codex tests `multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn`
  and `multi_agent_v2_completion_queues_message_for_direct_parent` assert one result
  communication per child turn and exact direct-parent queueing with
  `trigger_turn: false`.
- AgentVoice's focused runtime test sends verified child start/completion and native
  lifecycle items, observes the transcript output, and asserts that no `turn/start`
  or `turn/steer` occurs.
- Attachment tests exercise human typed `turn/start` and explicit
  `thread/realtime/appendSpeech`; thread export and exact-turn tests cover the
  AgentHUD observation boundary independently of manager input.

## Activation

This change alters the runtime/controller bundle but no public protocol or stored
schema. It needs the normal desktop installation and managed server restart before
a live AgentVoice session uses it. That restart ends the active call and interrupts
native work, so installation still requires the ordinary idle-frontend service
window. Historical native threads, transcript items, Work/Assignment records, and
AgentHUD data need no migration. This change performs no installation or restart.
