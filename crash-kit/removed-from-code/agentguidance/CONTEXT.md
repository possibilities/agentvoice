# Context

**Resource** — a directory under `~/resources/<slug>/` holding a gathered body of
material on one question: a seam, a report, the full source documents, and a
manifest. A resource is durable and refreshable; it outlives the session that
made it.
_Avoid_: collection, bundle, dump.

**Seam** — the `README.md` at a resource root. Its job is to get a reader into
the documents, not to summarize them: a pull-quote, a few routed entry points,
the index below the fold. Minimal by design.
_Avoid_: index, landing page, overview.

**Manifest** — the `MANIFEST.json` at a resource root. The contract between
`resource-create` and `resource-update`: what was gathered, from which queries,
what was deliberately left out, and what was wanted but unavailable. It records
provenance, not history.
_Avoid_: metadata, lockfile, index.

**Gap** — material a resource wants but could not include, recorded in the
manifest with a check that tells a later session whether it has since become
available.
_Avoid_: TODO, missing.

**Extension prompt** — a Markdown file with a recognized name under
`~/.config/agentguidance/` that `scripts/render` splices into a skill template
at its matching render point (an HTML comment naming the file). `SYSTEM.md`,
`GUIDELINES.md`, and `TOOLS.md` are the recognized names; an absent file
renders to nothing. The files are the operator's, linked there by AgentStart.
_Avoid_: extension guidance, plugin, override.

**Fragment** — a Markdown file under `fragments/` that `scripts/render`
splices into a skill template at its matching render point. Repo-owned shared
doctrine, unlike an extension prompt (operator-owned); a missing fragment
fails the render instead of rendering to nothing.
_Avoid_: snippet, partial, include.

**Post-sync hook** — `scripts/post-sync`, run by AgentStart's sync-skills after
this checkout's templates ship, so installed copies are always rendered. Here
it execs the render; the name is the fleet convention, the render is this
repo's use of it.
_Avoid_: build step, postinstall.

**Model invocation policy** — the portable fact recorded by
`disable-model-invocation` in a skill template's `SKILL.md` frontmatter;
absent or false means model-invocable. AgentStart derives Codex's inverse
product field when it renders the common capability pack.
_Avoid_: OpenAI policy (that is a rendered representation, not source).

**Orchestrator tools** — the section `fragments/orchestrator-tools.md`
renders into the orchestrator renditions only (the orchestrate skill and
agentvoice's ORCHESTRATOR.md): advertisement lines for skills of the
orchestrator's own craft, `prompt` first. Scoping is by advertisement —
every harness can still load the skill — not enforcement.
_Avoid_: orchestrator skills section, private tools.

**Orchestrator rendition** — a render target that carries the orchestrator
doctrine: the orchestrate skill for chat, agentvoice's ORCHESTRATOR.md for
voice. Formerly "orchestrator surfaces", renamed when Surface came to mean
the worker runtime.
_Avoid_: orchestrator surface.

**Surface** — the shared runtime coding-agent workers are placed on and
run in the open: the human can watch, join, or steer a placed worker, and
its lifecycle events wake the orchestrator. herdr is the reference
implementation. Distinct from the native dispatch facility each
orchestrator rendition carries for work in the orchestrator's own service.
_Avoid_: ADE, runner, backend, launcher.

**Dispatch** — sending work outward as a worker instead of doing it on the
orchestrator's thread: a speakable title plus a standalone brief. Two
lanes: the native facility for work in the orchestrator's own service,
placement on the Surface for the work itself.
_Avoid_: delegation, spawn.

**Worker** — an agent running one dispatched brief in its own context,
under the contract the orchestrator imbued: build unattended, collab when
a human joins its thread.
_Avoid_: sub-agent, child.

**Brief** — the standalone instructions a worker starts from: what to do,
where, what done looks like, where to write results. The worker's whole
starting context.
_Avoid_: ticket, task description.
