# 0007: Defer skill policy to Codex

Accepted 2026-09-04. Supersedes [0006](0006-enable-fixed-agentstart-skills-per-thread.md).

AgentVoice's direction is a headless Codex voice app with a TUI: preserve
upstream behavior and pass through explicitly configured prompts and settings.
Automatically enabling AgentStart's managed skill set is application policy
that does not belong in that default.

AgentVoice no longer reads `managed-skills.txt`, consults
`AGENTSTART_RESOURCES_ROOT`, or adds a `skills.config` policy on attachment,
fresh thread creation, or orchestrator/worker start and resume. The resident's
launch contract is unchanged. Codex owns skill discovery and enablement in
its ordinary environment.

Explicit `skills.config` entries in `orchestrator.config` still pass through
unchanged, including order and an empty list, to orchestrator and worker
start/resume requests. No application entries are prepended or appended.
`orchestrator.extra.config` retains its generic last-wins replacement behavior
for orchestrator requests; workers inherit `orchestrator.config`, not `extra`.

This removes deliberate injection, not ambient capabilities. Global plugins,
workspace skills, guidance, and Codex configuration remain native inputs.
Dedicated AgentVoice skill isolation and seeding are separate future decisions;
no negative skill policy, new profile, or global installation change is added.

An already-loaded thread can retain its old in-memory skill configuration.
New threads and cold resumes use the new request configuration, but merely
reattaching to a loaded thread is not a guaranteed reset. This change does not
restart services, force fresh threads, or rewrite history. Existing orchestrator
continuation, worker adoption and reports, account behavior, voice context,
and execution defaults are unchanged.

Regression coverage in `tests/params.test.ts` checks absence of manufactured
config, explicit skill-rule passthrough, and generic config replacement on both
start and resume. `src/resources.ts` and its inventory-specific tests are removed.
