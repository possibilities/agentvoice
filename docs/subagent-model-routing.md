# Subagent model routing

Researched September 8, 2026. The executable policy is the model guide and
assignment procedure in
[`roles/default/APPEND_SYSTEM_PROMPT.md`](../roles/default/APPEND_SYSTEM_PROMPT.md).
It is inline so the selected role delivers it through the existing native
`developerInstructions` control on start and resume. No extra prompt loader,
model registry, worker dispatcher or account integration is introduced.

## What changed and why

The default role already required deliberate model/effort selection, but supplied
no model-specific guidance, context preference or assignment receipt. Each child
now gets a semantic task name and an explicit model, effort and history decision.
Fresh, self-contained briefs are preferred; bounded forks preserve necessary
recent context; full forks deliberately accept inherited settings. Follow-ups
reuse a suitable child rather than pretending their tool can change its model.

The guide applies the operator's **Strong Leads and Right-Sized Subagents**
wiki note (`~/wiki/strong-leads-and-right-sized-subagents.md`): the lead owns
judgment and acceptance, with task, model and context all sized to a verifiable
deliverable. The model choices are recommendations synthesized from
the sources below, not benchmark results for this fleet.

[ADR 0047](adr/0047-adaptive-work-execution.md) extends
[ADR 0043](adr/0043-adaptive-conversation-first-delegation.md)'s adaptive policy
to all work, including implementation and edits. The root chooses direct or
delegated execution based on correctness, handoff costs, useful parallelism and
the current exchange; routine live call controls stay local. The model/effort/context
selection procedure applies when a worker is chosen. Related lookups can share
one assignment, and workers remain execution agents rather than compulsory managers.

## Current Codex catalog evidence

Official [Codex model guidance](https://learn.chatgpt.com/docs/models) recommends
Astra, Sol, Terra, Luna and Spark, and lists GPT-5.5 as a previous-generation
option. The native model cache inspected on September 8 local time reports
Codex `0.153.4`, fetched at `2026-09-09T00:55:48.899575Z`.
Only descriptive/capability fields were inspected; no credentials were read.

| Model ID | Catalog default effort | Catalog-supported efforts | Routing emphasis |
| --- | --- | --- | --- |
| `gpt-6-astra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Hardest workflows, architecture, synthesis and consequential judgment |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Complex, ambiguous work needing analysis and polish |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Everyday implementation and tool use with clear acceptance criteria |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` | Clear, repeatable extraction, transformation and bounded production |
| `gpt-5.5` | `medium` | `low`, `medium`, `high`, `xhigh` | Prior-generation alternative for explicit preference or demonstrated fit |
| `gpt-5.3-codex-spark` | `high` | `low`, `medium`, `high`, `xhigh` | Fast text-only coding iteration and focused exploration; worker routing deferred to a future harness |

These are observed capabilities, not permanent defaults to encode in a resolver.
For example, Sol's catalog default is low, while an ambiguous assignment can
justify more effort. The live tool/catalog takes precedence.
The snapshot also contains hidden internal models; those are not worker choices.

There is a discovery trap in stock `0.153.4`:

- [`MAX_SPAWN_AGENT_MODEL_OVERRIDES`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L33)
  is five. The
  [spawn description](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L763)
  takes only five picker-visible compatible entries. Spark is sixth in this
  snapshot, after Astra, Sol, Terra, Luna and GPT-5.5.
- The same release's `find_spawn_agent_model_name` checks the complete loaded
  catalog for an exact model and compatible multi-agent backend. Its diagnostic
  list is truncated too. Absence from the prose list therefore does not, by
  itself, prove rejection. This is source evidence, not a successful live Spark
  child invocation.
- Official [subagent examples](https://learn.chatgpt.com/docs/agent-configuration/subagents#example-1-pr-review)
  use Spark for code exploration and narrow fixes. A particular account, native
  backend, tool schema or later version can still restrict it.

Do not patch a catalog, change providers, or invent an alias to force access.
Use current native capability evidence when the short tool description omits
a candidate. A future catalog surface should retain native IDs, supported efforts,
modalities and backend compatibility, and distinguish selectable entries from
merely documented models. Unknown future models require fresh evidence.

## The earlier GPT-5 line

The requested family coverage includes earlier Codex models, but these must not
be advertised as current ChatGPT-authenticated choices. The descriptions below
summarize the [OpenAI API catalog](https://developers.openai.com/api/docs/models);
availability through the API is a different contract.

| Model | Historical fit if explicitly available in a supported native catalog |
| --- | --- |
| `gpt-5` | General reasoning, coding and agentic tasks with configurable effort |
| `gpt-5-codex` | GPT-5 specialized for agentic coding |
| `gpt-5.1` | General coding and agentic tasks with configurable effort |
| `gpt-5.1-codex` | Coding-specialized GPT-5.1 |
| `gpt-5.1-codex-mini` | Smaller, less capable, cost-oriented coding worker |
| `gpt-5.1-codex-max` | Long-running coding tasks |
| `gpt-5.2` | Professional work and general reasoning |
| `gpt-5.2-codex` | Long-horizon agentic coding |
| `gpt-5.3-codex` | General agentic coding; distinct from Spark |
| `gpt-5.4` | Coding, professional work and tool workflows |
| `gpt-5.4-mini` | Responsive coding and focused subagents |

The [April availability change](https://learn.chatgpt.com/docs/changelog#codex-2026-04-07)
removed the older GPT-5/5.1 and GPT-5.2-Codex choices for ChatGPT sign-in.
Current [retirement guidance](https://learn.chatgpt.com/docs/models#deprecated-codex-models)
also marks GPT-5.2 and GPT-5.3-Codex deprecated, and GPT-5.4/mini retired August 31.
Spark remains separately listed. API-only nano, Pro, Chat and specialized variants
are not added to AgentVoice's worker menu simply because they share a family
number. The default role includes guidance for every visible GPT-5/6 model in the
observed Codex catalog, rather than the entire multi-product API catalog.

## Effort, context and quota are separate decisions

[Official model guidance](https://learn.chatgpt.com/docs/models#pick-a-reasoning-effort)
recommends the lowest adequate effort and warns that deeper reasoning increases
time and token use. Max is exceptional depth; Ultra also invokes subagent
behavior. Effort is not a substitute for a stronger model, a better brief, or
necessary evidence. Fresh reviewers should receive the specification, change
set and checks without inheriting the author's whole reasoning trail.

[Speed guidance](https://learn.chatgpt.com/docs/agent-configuration/speed#codex-spark)
confirms Spark is a separate, less-capable fast model with independent limits,
available to Pro subscribers during research preview. It is text-only. It is
not Fast mode, which accelerates another model at higher credit consumption.
Neither API price ratios nor a lower effort setting establish exact savings
against subscription limits.

AgentVoice's current orchestrator is always a non-Spark Codex agent. It depends
on main quota to dispatch, inspect and integrate work, so Spark's independent
capacity cannot sustain this workflow once main quota is exhausted. The current
product scope defers Spark-worker routing to a future harness that can drive
those workers independently of the depleted Codex lead. This is a routing-policy
decision, not a claim that native Codex cannot spawn Spark while main quota
remains. Keep Spark's catalog research for that future work; remove it from the
current role's worker choices. Quota awareness can still help right-size the
active Codex models and preserve capacity for the lead.

## Proposed Codex-only usage integration

This is a prepared design, not an installed MCP or a claim about current quota.
Its present motivation is awareness of capacity for the Codex lead and supported
workers. Spark-lane observations are retained for future orchestration by another
harness, not as a recovery path for the current lead.

AgentUsage already separates `main` and `codex-spark` lanes in
`~/code/agentusage/src/codex/types.ts` and `src/codex/observe.ts`.
`src/balance/codex.ts` evaluates Spark independently of main exhaustion.
Its account-level `eligible`, `decisionGrade` and `headroomPercent` primarily
describe the main lane; reusing those as Spark eligibility would be wrong.
Its existing observer owns a managed account pool and can refresh OAuth state.
AgentVoice instead inherits native Codex authentication and forbids account
tools, profile reconciliation and quota-triggered runtime replacement.

Recommended contract for a future read-only surface:

1. Separate **native model capabilities** from **usage observations**. The owned
   Codex child's paginated `model/list` is the capability authority. AgentUsage
   is not currently a model-catalog authority.
2. Fix the agent-facing server to Codex at construction. Expose only a bounded
   catalog/usage read, with no provider argument that can reveal Claude or Grok,
   and no login, refresh, balance, claim, focus, reset or prepare tools. Reuse
   existing observation production rather than starting another token owner.
3. Bind usage to the call's exact native account through an explicitly designed
   non-secret identity contract. Unknown or mismatched correspondence returns
   unavailable; never select the pool's best account, or infer identity from a
   model, email guess, profile directory or newest observation.
4. Return an allowlisted projection: source, observation time, freshness,
   correspondence status, lane IDs and each reported window's remaining percent,
   duration and reset time. Omit credentials, raw provider payloads, unrelated
   accounts and account-management recommendations. A reset time passing does
   not prove a new measurement or renewed capacity.
5. Keep catalog availability, quota availability and requested-versus-reported
   child execution distinct. Preserve stale/unavailable/error states. Fetch at
   meaningful dispatch boundaries, not before every tiny tool call. Native
   authentication and native subagent execution remain unchanged.

Native `account/rateLimits/read` and `account/rateLimits/updated` may provide a
better same-child source than matching an external pool. Their multi-limit
response needs validation for Spark. This would require an explicit, narrow
revision to AgentVoice's current account-method boundary; this change makes
none. An AgentUsage MCP is useful fleet-wide only if it can satisfy the identity
contract for AgentVoice, and its deployment must expose the Codex projection
alone. A new cross-tool dependency would also update AgentStart's fleet map.

Acceptance fixtures for that integration should cover main exhausted/Spark
available without treating the lead as able to continue, Spark exhausted/main
available, stale and future-dated observations,
missing or malformed windows, account mismatch, provider-data exclusion,
pagination, and runtime-replacement invalidation. No fixture needs credentials,
inference or audio.

## Verification boundary

Verified in the task worktree:

- 35 focused role, convention-prompt and mode tests passed (354 assertions).
- Typecheck, Biome and local document-link checks passed.
- The actual role append was delivered intact by both native parameter builders,
  with no lead-model override.
- The stock-Codex delegation-policy probe passed: the complete append and exact
  mode reached the fake local Responses endpoint on start and on exact resume
  in a replacement owned child. Its disposable state and child were cleaned up;
  external network was denied and no live inference or audio was used.

Prompt-loading and role tests verify delivery of the authored text.
They cannot prove that a model follows the routing policy, that Spark accepts a
live child call, or that quota is sufficient. A later authorized live trial
should inspect actual spawn arguments and reported child settings for a narrow
lookup, a routine edit and a consequential review. No live call or installation
is part of this prompt change.
