# Persistent workspace voice transcripts

**Current policy:** [ADR 0074](0074-fail-closed-voice-history.md) removes ADR 0066 automatic history injection after duplicate-work incidents.

**Context update:** [ADR 0066](0066-same-thread-voice-continuity.md) supersedes only
the prohibition on reusing these files as model context, permitting bounded
completed same-root speech on v3 starts. Other recording guarantees remain.

Each call controller records native voice items from verified identity through
teardown into private workspace/thread JSONL, retaining recordings across calls
and runtime replacements. This supersedes the no-automatic-persistence clause in
[0018](0018-read-only-lifecycle-event-socket.md); its live event feed remains transient:
`attach agent` joins native Codex, while `attach voice` opens codex-viewer against
the active or saved transcript; neither viewer ownership nor native history owns
these files, and they are never injected into model context. Completed text is
fsynced and protected from IPC soft-pressure drops; failures and interrupted runs
remain visible rather than implying a complete or audio-heard transcript.
