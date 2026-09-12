# 0048: One working doctrine with explicit runtime boundaries

Accepted September 12, 2026. Extends
[ADR 0047](0047-adaptive-work-execution.md) from adaptive execution to a common
working doctrine for broad tasks. Its direct/delegated judgment, conversational
continuity, explicit presentation context, quiet completion handling, and
resource boundaries remain. Partially supersedes
[ADR 0040](0040-deliberate-subagent-routing.md): the default append retains the
assignment procedure and native capability checks, while dated model tables
remain in the [routing reference](../subagent-model-routing.md) rather than
being repeated in every turn.

The human wants autonomous ownership and collaboration available without
invoking the former collab/build skills. The default role's general append now
covers research, analysis, documents, design, software, and tool actions. It
establishes the intended outcome, essential constraints, proportional planning,
continuity across tasks and context windows, evidence-based correction,
appropriate verification, and authorized delivery. Direct execution and useful
delegation remain choices, not fixed workflow phases. The lead owns acceptance;
workers own their bounded assignments. The role no longer identifies every
session as development of AgentVoice itself.

The rationale follows the September 7 stored snapshot of the official
[Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and the September 4 [prompt/skill audit advice](https://x.com/i/status/2095991462416490862): explicit completion
and decision boundaries help follow-through, while elaborate itineraries,
unconditional document loading, and repeated testing can overconstrain capable
models. Older collab/build guidance already separated authorization from task
size; the new append carries that meaning continuously. It retains shared-work
protection, project language, consequential decision records, delivery scope,
resource cleanup, and human-granted leases. A working record preserves intent,
constraints, pending decisions, and results awaiting announcement; it is not a
worker registry or a new runtime persistence guarantee.

The single general doctrine can be reused across working-agent surfaces, but
text does not enable native capabilities. The existing companion mode remains
the narrow AgentVoice adapter that overrides native delegation restrictions.
The append's exact mailbox instructions apply only when the AgentVoice call
runtime supplies that protocol. A standalone TUI must use its actual native
completion mechanism; it is not promised wake-ups or survival across shutdown.
This change adds no loader, global configuration, TUI wiring, role-snapshot
migration, worker executor, or continuation service.

The human additionally clarified that **hold and mute mean conversational
silence while authorized work continues**. Both the working-agent append and a
small voice-agent append carry that rule. Hold does not cancel tasks or leases,
stop dependencies, or authorize acting on overheard speech. Human-dependent
questions and findings wait for explicit unmute/off-hold/resumption; independent
work continues. The exact spoken acknowledgments remain “Muted” and “Unmuted,”
with no physical audio-control claim.

The default role previously had no voice-agent prompt file. The inspected stock
Codex backend prompt instructs its conversational model to delegate action and
steering, but contains no hold/mute rule; it does not explicitly order work to
stop. A working-agent-only instruction cannot establish that the speech model
will preserve this distinction. `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md` adds only
the presentation/handoff boundary, using the existing
[voice-append contract](0013-convention-prompt-files.md). It leaves the stock
voice base intact and occupies the startup-context slot with the authored
suffix, not automatic history. Consequently, selecting this default role with
an explicit competing startup-context setting is an existing validation error;
settings must not be silently overwritten. Source changes load on a later call
or authorized runtime replacement and do not change the current call.

The tradeoff is discretion rather than prescribed ceremonies. An agent can
still stop too early, misjudge delegation, lose deferred findings, or speak
while held. Static source review and loading tests establish configuration
compatibility, not behavior. Evaluate concrete tasks and failure cases across
known voice, typed-within-voice, standalone TUI, and unidentified environments.
Include hold during execution, a child finishing while held, blocked input with
independent work, explicit work cancellation, resume, and conflicting
startup-context configuration. Do not run live trials or restart a call merely
to validate a prompt without their own authorization.
