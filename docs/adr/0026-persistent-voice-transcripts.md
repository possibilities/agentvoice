# Persistent workspace voice transcripts

Each call controller records native voice items from verified identity through
teardown into private workspace/thread JSONL, retaining recordings across calls
and runtime replacements. This supersedes the no-automatic-persistence clause in
[0018](0018-read-only-lifecycle-event-socket.md); its live event feed remains transient:
`attach agent` joins native Codex, while `attach voice` opens codex-viewer against
the active or saved transcript; neither viewer ownership nor native history owns
these files, and they are never injected into model context. Completed text is
fsynced and protected from IPC soft-pressure drops; failures and interrupted runs
remain visible rather than implying a complete or audio-heard transcript.
