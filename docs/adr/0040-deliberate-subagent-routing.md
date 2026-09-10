# 0040: The default role guides deliberate subagent routing

Accepted September 8, 2026. Extends
[ADR 0031](0031-role-owned-delegation.md) without changing its conversation-first
delegation mode or the operator's lead model/effort settings.

Every child assignment needs a deliberate model, reasoning effort, history
choice and semantic task name. The default role's existing append now carries
a concise, dated guide to all visible GPT-5/6 models in the observed Codex
catalog, including Spark, plus the selection procedure. Inline guidance reaches
every invocation through the existing prompt control; a separate file would
require discovery or another loader. The companion
[research and integration design](../subagent-model-routing.md) records sources,
older model status, native catalog limitations and future quota boundaries.

The lead retains judgment and acceptance. Workers receive a complete verifiable
assignment and the least costly model likely to finish it correctly. Fresh
briefs are preferred; bounded context preserves necessary nuance; full history
deliberately inherits model and effort. Related follow-ups retain a suitable
child. These are task-relative judgments, not a fixed role-to-model table.

Native capabilities remain authoritative. The inspected stock Codex release
abbreviates its spawn description to five models while validating against a
broader catalog, which can hide Spark from the description. The guide is not
permission to use unsupported models or to claim requested settings were
actually applied. Historical/API-only models are not advertised as current
ChatGPT-authenticated choices.

The current non-Spark Codex lead needs main quota to dispatch, judge and
integrate work. Spark's independent limits cannot sustain that workflow after
main quota is exhausted. Spark remains in the reference guide, but worker
routing to it is deferred to future orchestration by another harness. This
product scope does not imply native Spark spawning is technically impossible
while main quota remains. Quota is unknown without a fresh, account-correlated
source; unused capacity is not a reason to invent work or lower acceptance standards.
No AgentUsage MCP, account access, switching, runtime replacement or native
model-catalog override is added. A future Codex-only usage surface needs its own
identity and freshness contract and a scoped decision before extending the
current account-method boundary.

The consequence is a modest increase in default-role context and a dated model
guide to maintain. Prompt delivery is testable without inference; compliance,
actual Spark execution and quota availability require separately scoped live
evidence. Other roles and native prompt/settings precedence are unchanged.
