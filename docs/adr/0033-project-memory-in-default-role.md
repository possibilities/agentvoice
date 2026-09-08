# 0033: Project memory is part of the default role

Accepted September 8, 2026. The default role carries a concise policy for
repository vocabulary, decision history, and worker context because these
conventions must apply even when `/collab` or `/build` is not invoked. Workers
receive the target repository and consult its instructions, glossary, and
relevant ADRs; a voice workspace is not necessarily that repository.

The portable convention remains in AgentGuidance's
`fragments/domain-model.md`, shared by the two skills. Keep the role summary
and that fragment aligned. The existing app-owned append and AgentStart's
prompt link deliver this policy without a new prompt-composition layer.

Glossaries hold canonical language, working notes hold task state, and ADRs
retain decision rationale. Changed decisions are explicitly superseded with
links to their replacements; removing code does not erase its decision history.
