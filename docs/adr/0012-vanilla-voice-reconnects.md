# 0012: Reconnect voice calls without AgentVoice instructions

**Startup-context policy update:** [ADR 0020](0020-native-launch-defaults.md) removes the retained false default; explicit controls and the removal of reconnect instructions remain current.

**Partially superseded by [ADR 0017](0017-remove-spoken-history-replay.md):** quiet resume remains retired, and the saved-speech replay exception described below has now also been removed.

**Default-reference clarification, 2026-09-06:** [ADR 0019](0019-client-server-default-baseline.md)
supersedes the app-server-only direction stated below. Vanilla now explicitly
refers to the client-and-server experience, including voice. This does not
reinstate quiet resume, saved-speech replay or any other retired behavior.

2026-09-05. Supersedes [ADR 0010](0010-quiet-voice-resume.md). The operator ruled that the vanilla-by-default
direction outranks the quiet-resume instruction [ADR 0010](0010-quiet-voice-resume.md) installed as a default,
while keeping [ADR 0011](0011-spoken-history-continuity.md)'s saved-speech replay as an opt-out default.

## Decision

- Quiet resume is removed, not defaulted off. No AgentVoice-authored instruction
  rides any `thread/realtime/start`. The only AgentVoice content a resumed or
  redialed call can carry is replayed saved speech from the same conversation,
  with its one-item preface marking it as past conversation. `voice.quiet-resume`
  is a retired key and errors like other retired configuration, so a stale
  server.json fails visibly rather than silently changing behavior.
- `voice.replay-spoken-history` keeps [ADR 0011](0011-spoken-history-continuity.md)'s true default. False skips
  history reads and replay, and the reconnect is then built the same way as a
  first call. With replay on and no saved speech, nothing is sent.
- `voice.include-startup-context` keeps [ADR 0011](0011-spoken-history-continuity.md)'s false default. That remains a
  documented departure from the stock app-server default and was not part of
  this ruling.

## Why

Stock app-server has no continuity semantics of its own. Replayed speech is the
conversation's own saved words, read from native history; the quiet-resume text
was guidance AgentVoice invented and sent on every continued launch and redial.
The operator draws the vanilla line between those two: restoring what was
actually said is acceptable as a default, authoring new instructions for the
voice model is not. The desktop client injects its own silence prompt, but
AgentVoice's direction is the app-server, not desktop parity.

## Consequences

Without a wait instruction, a reconnect can speak unsolicited if the model
treats replayed speech, or an explicitly enabled native startup snapshot, as
something to continue. The replay preface says the segments are past
conversation, not requests; that descriptive note is the only guidance left.
Fake protocol tests cover the wire shape only. Live acceptance of the default
reconnect remains with the operator.
