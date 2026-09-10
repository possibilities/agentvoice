# 0036 — Desktop attachment to a mobile-owned call

Status: accepted, 2026-09-08.

The operator needs to see voice and orchestrator conversations and steer Codex
while a phone owns audio. The backend may run on desktop or in Android/Termux.
The two-pane terminal itself runs on desktop in both cases.

Add `agentvoice --attach [--host <ssh-host>] [--workspace <dir>]`. Preserve bare
AgentVoice's existing three-pane voice-owning behavior. The new view starts no
frontend/audio, waits read-only for a call and never ends that call on detach.
Native attachment admission follows verified thread/control readiness, so voice
negotiation cannot hide an otherwise ready orchestrator.

Remote observation and steering use existing authenticated SSH, with strict
host verification and no agent/port forwarding. Do not extend the WSS voice
gateway or expose native, control, attachment or event sockets. Desktop owns
smolmux and codex-viewer; Termux runs the existing stock attachment. A bounded
NDJSON helper carries only identity/readiness and recorded voice text to a
private temporary desktop transcript. The copy is removed after pane shutdown.

Pin client, canonical workspace, thread, controller instance and runtime
generation. Validate the exact controller again when issuing the native ticket.
Call end, loss, replacement or a pane exit ends the view without automatic
reconnect or input replay. Voice redial remains within the same attachment.

This keeps native approvals and typed steering in the established stock gateway
and keeps phone audio ownership independent of desktop observation. The cost is
an updated CLI on each host and working SSH access for a phone-hosted backend.
See [composition](../composition.md) for limits and verification.
