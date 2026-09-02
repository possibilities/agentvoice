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

**Codex–Fx contender**

The pinned native Codex voice agent paired with the Fx orchestrator agent through client-managed delegations and handoffs. Its standalone App-server is a voice sidecar only; it must start zero Codex coding turns.

_Avoid_: patched reference, Codex orchestrator, LiveKit-free contender.

**Codpiece**

The voice layer as a product: the voice sidecar, the orchestrator adapter contract with its backends, and the frontends that dial it. Any number of parts; the requirement is that a frontend can use the whole as one backend to control agents by voice.

_Avoid_: the sidecar alone (that is the voice sidecar), voice app, Codex fork (that is the Codpiece workshop's product, not the layer).

**Voice sidecar**

The standalone Codex-derived process that owns the Codex–Fx contender's private realtime voice session and narrow compatibility protocol while leaving all workspace work to the orchestrator agent. It proxies SDP and sideband only; audio flows peer to peer between the frontend and the voice agent. It contains no Codex coding-agent runtime.

_Avoid_: stripped App-server, backend agent, coding sidecar, extracted voice model, audio path.

**Orchestrator adapter**

The contract every orchestrator backend implements for the voice layer: start and identity, admit (queued or steering, with a turn id), wait for a turn's outcome and final text, interrupt, lifecycle events (turn started and ended, attention raised and cleared, agent state), stop. `fx acp` is the backend of record; the PTY-launched work-control path is the reference adapter.

_Avoid_: driver, plugin, orchestrator client, transport.

**Backend**

An orchestrator agent reached through an orchestrator adapter. Named by its adapter (`fx-acp`, `fx-work-control`).

_Avoid_: agent (ambiguous with the voice agent), server, model.

**Frontend**

A program that dials the voice sidecar's realtime protocol and owns the audio path: microphone capture, playback, mute gates, and the WebRTC peer. The bare-bones TUI is the first one.

_Avoid_: console (the archive's word for a larger system), client, surface.

**Fx authority**

The single configured Codex subscription authority owned by Fx for both orchestrator-agent inference and voice-sidecar access. Fx alone selects the account, refreshes and persists its session, and rotates credentials.

_Avoid_: shared auth file, sidecar login, duplicate Codex authorization.

**Credential broker**

The private persistent framed service on Fx's inherited descriptor 3 that resolves and refreshes bounded runtime authority leases. AgentVoice transfers its paused stream opaquely to one voice sidecar and never reads or relays bearer bytes.

_Avoid_: Unix-socket service, AgentVoice auth proxy, credential JSON-RPC.

**Runtime authority lease**

A bounded in-memory access capability issued by the Credential broker to one voice-sidecar process. It contains an access token, pinned account identity, refresh deadline, and monotonic generation, but never a refresh token or serialized Fx session.

_Avoid_: copied auth.json, API key, refresh-token handoff.

**Async delegation**

A delegation that continues in the background after the voice agent acknowledges it, so conversation and interruption remain available while the orchestrator agent works.

_Avoid_: blocking tool call, fire-and-forget task.

**In-flight steering**

A delegation admitted into the orchestrator agent's currently active turn. Cancelling work and starting a later prompt is not in-flight steering.

_Avoid_: cancel-and-follow-up, queued correction.

**Full-duplex overlap**

An interval in which evaluator speech and audible voice-agent output are both active. Mere ability to interrupt between spoken responses does not establish full-duplex overlap.

_Avoid_: multi-turn conversation, sequential interruption.

**Pairwise audio judge**

The identity-blind, order-counterbalanced evaluator that compares two completed runs using deterministic evidence plus their isolated-output and conversation recordings.

_Avoid_: audio analyzer, voice scorer.

**Listening bundle**

The hash-bound, full-length MP3 copies prepared for the pairwise audio judge while the original PCM recordings remain the signal-analysis authority.

_Avoid_: clips, compressed evidence.
