# 0004: A resident Server owns the coordination runtime

Superseding 0002's "attaches to the Client" and amending 0003: the
coordination runtime — the attachment to the resident, the persisted
orchestrator agent, workers, rotation — moves out of the Console into a
second launchd job, the Server, which also takes both control listeners.
The Console becomes a control-attachment peer in the `voice` role (the
shared TUI plus the media engine), and the Remote console attaches to the
Server, working with no Console open.

The cut follows two seams that already existed: the in-process
runtime↔transport event interface becomes the session-signaling frames, and
the Remote protocol gains peer roles. Mute authority stays with the media
owner, so a dropped link fails safe by releasing remote-sourced holds
locally. Two consumers justify the extra process where the resident collapse
once removed one: the orchestrator stays serviced with no console open
(dispatch answered, reports published, rotation at idle — no self-originated
inference), and a future mobile app is just another voice peer speaking the
same seam, with media direct to the voice agent and signaling through the
Server, whose codex-held bearer keeps credentials off the endpoint.
