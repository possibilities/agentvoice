# 0024: Waiting local server and pointer-only frontend

Status review 2026-09-08: partially superseded.
[0025](0025-launchagent-default-workspaces.md) supplies the default service/workspace lifecycle and [0033](0033-client-owned-native-media.md) moves audio/WebRTC to clients. The waiting server and pointer frontend remain.

Accepted 2026-09-06. Supersedes the foreground-only topology in ADRs [0009](0009-one-foreground-workspace.md)/[0015](0015-retain-controller-replace-runtime.md)
and the animated keyboard UI. Lifecycle API controls retain [ADR 0016](0016-restart-handoff.md) semantics.

`agentvoice server` stays foreground and waits on one private workspace socket;
`agentvoice` connects as the sole frontend and starts a call whose server-owned
controller/runtime retain native identity, audio, Codex and cleanup authority.
Frontend disconnect releases holds and closes that call before the server accepts
another, while the static monochrome frontend exposes only connection status,
YOU/AGENT mute buttons and conditional pointer push-to-talk.
In-call Fresh, meters and all application keybindings are removed. The MCP/API
status, redial and runtime restart operations remain reachable and retain their
server support, including optional handoffs and operation journals. The initial
implementation removed these too broadly; the operator clarified that only
orphaned UI support should be stripped. Runtime replacement keeps the frontend
and call controller alive. Native history selection at server launch, automatic
media renewal, read-only observation and guarded stock Codex attachment remain.
