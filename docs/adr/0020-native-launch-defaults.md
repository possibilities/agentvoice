# 0020: Native permissions and context, fresh ordinary launches

**Startup-context update:** [ADR 0029](0029-desktop-startup-context.md) supersedes this document only for the startup-context default: AgentVoice now sends false to match the inspected desktop client. Other decisions remain in force.

Accepted 2026-09-06 after the operator reviewed the defaults individually.
Supersedes the mandatory full-access and implicit continuation policies in
[ADR 0009](0009-one-foreground-workspace.md) and the startup-context-off policy retained in ADRs [0011](0011-spoken-history-continuity.md), [0012](0012-vanilla-voice-reconnects.md) and [0017](0017-remove-spoken-history-replay.md).
The client-and-server comparison baseline in [ADR 0019](0019-client-server-default-baseline.md) remains in effect.

## Decision

- Ordinary launch creates a new native conversation. `--continue` explicitly
  selects the latest eligible conversation in the canonical workspace;
  `--resume` selects an eligible exact ID. `--fresh`/`--no-continue` remain
  explicit fresh aliases. A fresh launch skips resume-selection history lookup.
- Full access is optional. Without `--allow-full-access`, unset sandbox and
  approval fields stay omitted, and configured native modes/profiles are accepted.
  With the flag, select danger-full-access/never explicitly at native startup
  and in thread requests, overriding conflicting permission selectors while
  preserving unrelated raw configuration. Native managed requirements still apply.
  Remove launch refusal, full-access-only configuration validation and guards
  that stop the child when native permissions are restricted or unreported.
- Leave `includeStartupContext` omitted unless explicitly configured or owned by
  the voice append file. Codex currently includes its startup snapshot when
  omitted. Preserve explicit true/false/null, initial items and the existing
  single-owner voice-append rule. Tail flush and startup-text overrides remain
  unset by default.
- Keep the realtime v3 default and required connection infrastructure. An explicit
  v3 request matches the inspected desktop client path; omitting it would choose
  the server's v1 fallback. Protocol selection is separate from prompt policy.

The startup-context choice deliberately inherits server resolution. The operator
reaffirmed it after learning that desktop disables this snapshot alongside its
own context machinery. Do not describe this as established desktop context parity
or copy private frontend machinery merely to align one boolean.

## Consequences

AgentVoice still has no approval UI. Unsupported human interaction receives
native denial/decline responses or protocol errors with a visible explanation;
approval-dependent actions may be blocked. Do not fabricate consent or infer
effective permission state from what was requested. Voice itself does not require
full access; the operator observed desktop both show an approval card and explain
the permission problem aloud. That observation does not guarantee speech in
AgentVoice or every approval case.

Fresh is ordinary launch policy, not a change to runtime restart. Restart retains
the exact conversation and leases for native resume and any explicit handoff.
History, thread ownership checks for explicit selection, active metadata/event
observation and Fresh's media/identity transition remain intact. No saved history
is deleted, and AgentVoice's removed speech replay/instructions remain removed.
Native startup context can include recent work from other conversations, even
when the working thread is new; fresh selection is not memory isolation.

Validation uses fake native protocol/media tests for request omission, explicit
overrides, restricted/native permission responses, selection and restart identity,
plus schema drift, typecheck and lint. No live restart/audio experiment is needed
to land this change, and those checks cannot establish audible behavior.
