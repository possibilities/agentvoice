# Domain glossary

**Voice agent**

The realtime speech model that listens, speaks, manages interruption, and decides when coding work needs the orchestrator agent.

_Avoid_: voice frontend, speech wrapper.

**Orchestrator agent**

The persistent coding agent attached to the workspace. It investigates, edits, runs tools, and returns work results to the voice agent.

_Avoid_: backend agent, tool agent.

**Delegation**

A request from the voice agent that starts or steers work by the orchestrator agent.

_Avoid_: tool call, sub-agent call.

**Handoff**

The path that returns orchestrator-agent progress or results to the voice agent so it can respond aloud.

_Avoid_: callback, relay.

**Reference contender**

The pinned Codex App-server voice stack used as the product-quality baseline for every comparison run.

_Avoid_: control agent, old agent.

**LiveKit contender**

The LiveKit Agents voice agent connected to the Fx orchestrator agent. LiveKit hosts the realtime conversation and media path; Fx performs workspace work.

_Avoid_: LiveKit orchestrator, Fx voice model.

**Async delegation**

A delegation that continues in the background after the voice agent acknowledges it, so conversation and interruption remain available while the orchestrator agent works.

_Avoid_: blocking tool call, fire-and-forget task.

**In-flight steering**

A delegation admitted into the orchestrator agent's currently active turn. Cancelling work and starting a later prompt is not in-flight steering.

_Avoid_: cancel-and-follow-up, queued correction.

**Full-duplex overlap**

An interval in which evaluator speech and audible voice-agent output are both active. Mere ability to interrupt between spoken responses does not establish full-duplex overlap.

_Avoid_: multi-turn conversation, sequential interruption.
