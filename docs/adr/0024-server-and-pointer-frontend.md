# 0024: Waiting local server and pointer-only frontend

Accepted 2026-09-06. Supersedes the foreground-only topology in ADRs 0009/0015,
the lifecycle controls and handoffs in ADR 0016, and the animated keyboard UI.

`agentvoice server` stays foreground and waits on one private workspace socket;
`agentvoice` connects as the sole frontend and starts a call whose server-owned
controller/runtime retain native identity, audio, Codex and cleanup authority.
Frontend disconnect releases holds and closes that call before the server accepts
another, while the static monochrome frontend exposes only connection status,
YOU/AGENT mute buttons and conditional pointer push-to-talk.
Manual redial, in-call Fresh, runtime restart, handoffs, journals, meters and all
application keybindings are removed, including backend mutation methods; native
history selection at server launch, automatic media renewal, read-only observation
and guarded stock Codex attachment remain.
