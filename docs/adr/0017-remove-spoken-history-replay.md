# Remove automatic spoken-history replay

**Partial policy update:** [ADR 0020](0020-native-launch-defaults.md) replaces the retained startup-context false default with native resolution and makes ordinary launch fresh. The replay removal remains current.

2026-09-05. Supersedes the replay decisions in ADRs 0011 and 0012. The operator
asked to remove the feature completely and try the product without automatic
voice memory before adding more application policy. AgentVoice should remain
a thin voice layer with explicit prompt and configuration customization.

## Decision

- Remove automatic reading and injection of saved speech on continue, explicit
  resume and redial. Fresh and first calls use the same voice-context rules.
  No AgentVoice-authored past-conversation preface or initial items are generated.
- Delete the native timeline reader, legacy JSONL fallback, replay bounds and
  standalone history probe. Voice startup no longer waits on those reads or
  produces their truncation notices and errors.
- Retire `voice.replay-spoken-history`; remove it from the schema and resolved
  configuration. A present key, including false, errors with removal guidance.
  Do not silently edit user configuration or migrate/delete native history.
- Preserve native working-thread selection/resume, saved native history,
  explicit prompt files and raw `voice.extra.initialItems` (including empty and
  null values). Populated initial items still require effective realtime v3.
- Keep the existing WebRTC v3 compatibility default and native startup-context
  default of false. Explicit native startup-context overrides remain available;
  native tail-flush controls remain unset by default. This decision removes
  replay rather than changing those separately established defaults.
- Preserve the explicit one-use restart handoff (ADR 0016). It submits a task
  supplied with a restart request, independently of voice-history continuity.

## Consequences and validation

Resuming a working conversation does not promise that the new voice call will
recall earlier speech. Native Codex still owns working-thread history and its
own context behavior. Users can supply native context overrides when wanted.

Protocol tests exercise continue, explicit resume, redial and Fresh without
speech-history reads or generated initial items; they also cover explicit native
context passthrough and rejection of the retired setting. Existing session tests
retain stale-start, stop and notification-attribution coverage. These checks do
not establish live model recall or whether any audio was heard.
