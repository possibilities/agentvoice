# Route native voice delegations through Fx

The Codex–Fx contender keeps a pinned, minimally patched App-server as a voice sidecar and uses `clientManagedHandoffs` to expose native delegations without starting Codex coding turns. The harness admits those delegations through Fx's authenticated work-control socket and returns progress and results with `thread/realtime/appendSpeech`, preserving native full-duplex speech while keeping orchestration under Fx control.
