# 0059: Describe mailbox lifetime separately from conversational hold

Partially superseded 2026-09-15 by
[0080](0080-direct-child-completion-delivery.md), which removes all mailbox
lifetime, opening and guidance behavior described below. The separate conclusion
that conversational hold is prompt policy rather than runtime state remains active.

Accepted September 14, 2026. Clarifies the tool description against
[0053](0053-retain-workspace-session-across-frontend-detach.md), without changing
that decision's runtime ownership or the control protocol.

The mailbox belongs to the retained server workspace-session controller. Entries
and cached openings survive frontend detach and runtime replacement, and clear
on explicit new_session or server shutdown. Replacement interrupts native work
and rebuilds observed inventory; old wake-ups are not automatically resubmitted.
Replace ambiguous “call shutdown” wording in the generated control tool description.

AgentStart owns companion manager/worker guidance and speech acknowledgment
policy (its ADR 0012). Conversational hold remains prompt policy distinct from
physical mute/PTT and mailbox state. No shared hold mechanism, output filtering,
new UI, automatic HUD writes, model change or live restart is introduced.

Contract/render checks and nonrestarting installation establish available source
and tool text. Existing runtime generations and independent role snapshots retain
loaded bytes; live conversational compliance requires separate human validation.
