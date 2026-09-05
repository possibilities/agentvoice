# 0012: Reconnect voice calls without AgentVoice instructions

2026-09-05. Supersedes ADR 0010 and amends ADR 0011's replay default. The operator
ruled that the vanilla-by-default direction outranks the continuity fixes those
ADRs had installed as defaults.

## Decision

- Quiet resume is removed, not defaulted off. No AgentVoice-authored instruction
  rides any `thread/realtime/start`; a resumed or redialed call is built the same
  way as a first call. `voice.quiet-resume` is a retired key and errors like other
  retired configuration, so a stale server.json fails visibly rather than silently
  changing behavior.
- `voice.replay-spoken-history` defaults false. Explicit true keeps ADR 0011's
  behavior unchanged: bounded saved speech from the selected thread, prefaced by
  one developer item marking it as past conversation. With replay enabled and no
  saved speech, nothing is sent.
- `voice.include-startup-context` keeps ADR 0011's false default. That remains a
  documented departure from the stock app-server default and was not part of
  this ruling.

## Why

Stock app-server has no continuity semantics of its own. ADR 0010's instruction
and ADR 0011's replay put AgentVoice text on every default continued launch and
redial, each default compensating for the one before it: startup context off
removed native context, replay reintroduced context from AgentVoice, and the
quiet instruction mostly governed how the model treated that replay. The desktop
client injects its own silence prompt, but AgentVoice's direction is the
app-server, not desktop parity.

## Consequences

A default reconnect can speak unsolicited again if native startup context is
enabled explicitly, because the model then receives old context with no wait
instruction. That is stock behavior; replay and startup context remain opt-ins.
Fake protocol tests cover the wire shape only. Live acceptance of the default
reconnect and of opt-in replay remains with the operator.
