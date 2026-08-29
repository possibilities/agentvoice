# AgentSurface

AgentSurface is the fleet's integration point with herdr, the launch surface:
each subcommand ties `~/code/agent*` tools to the running herdr session. The
first integration is `host` — run a fleet TUI on the popup's terminal and
realize every session directive it emits as a herdr workspace (or worktree)
with an agent started in it. The TUIs themselves live with the tools they
front (agentlaunch's `--x-surface` launch form is the first); the
`surface-handoff-protocol` wiki page is the directive contract, and
`directive.schema.json` its published format. The second is
`conversation slug` — a short list-ready name for any conversation, derived
from its first user prompt by the conversation's own harness at the
catalog's metadata level. The third is the message bus — `agents` and
`message` — agents on the surface listing and messaging each other, with
herdr delivering each message as typed input. `confirm` is the terminal
safety boundary for keybindings that must require an explicit decision before
running their command.

The boundary is strict in every direction. Herdr owns every topology
semantic: where worktrees go, what a workspace is, when a pane is an
available shell. The hosted tool owns its whole choice UX and everything in
its directives; AgentSurface never inspects why a directive says what it
says. AgentSurface realizes directives over herdr's public commands and
re-implements neither side.

## Commands

- `bun run check` — lint, typecheck, and tests.
- `bun run generate:schemas` — regenerate the checked-in JSON Schema.
- `bash scripts/install.sh --install` — hardened rerunnable source-link install.
- `bash scripts/install.sh --uninstall` — remove only a verified managed install.

## Architecture

- `main.ts` owns routing, exit semantics, and the popup-friendly failure
  hold. Routes are `host`, `confirm`, `conversation slug`, `session dump`, `session resume`, `agents`, `message`, the internal
  `execute-directive` and `name-tab`, `--help`, `--version`. The conversation
  route holds nothing on screen and exits 3 (no such transcript) or 4 (no
  user prompt yet) so machine callers can poll.
- `host.ts` is the generic surface host: check herdr, resolve the context
  cwd (the focused pane's, asked of herdr — the popup does not inherit it),
  and run the tool with stdout piped while stdin and stderr stay the
  popup's tty — the tool renders on stderr, and stdout is the directive
  stream. The host reads the pipe as it flows and spawns a detached
  `agentsurface execute-directive` per complete line — a background submit
  launches while the tool's form stays open, and the popup still closes
  the moment the tool exits. Every line read is appended to a per-run
  evidence log first. A refused line is notified and reported at exit; it
  never stops the stream. A tool that exits nonzero holds the popup so its
  message can be read (130, the operator's ctrl+c, excepted).
- `directive-schema.ts` is the protocol: the session directive as a strict
  zod schema, published as `directive.schema.json`, refusing unknown keys
  and unknown schema_versions. `directive.ts` is the detached half that
  realizes one: it reuses a workspace already hosting the project (a tab),
  creates one (or a worktree) otherwise, starts the agent, retries a raced
  `agent_name_taken`, appends the record (the directive's `record` extras
  riding beside the host's fields, which win collisions), and reports
  failure through a herdr notification.
- `herdr.ts` speaks the herdr CLI's socket API: workspace/worktree/tab
  create, the surface listings, and agent start (with the pane-busy ready
  retry). The intent rides the launch as an `--x-prompt-file` spool
  reference — herdr types the command into the pane's shell and refuses
  control characters, so the text itself cannot travel as an argument;
  agentlaunch appends the file's text as the final native token, which is
  why a startup dialog still cannot drop it. The executor prunes the spool
  by age, and the host prunes old evidence logs the same way. JSON answers only;
  success on stdout, errors on stderr.
- `bus.ts` is the message bus. An agent answers to three addresses: its
  name — the label of the tab hosting its pane, the tab namer's slug or a
  hand rename — its session id, and its place, the workspace it works in,
  which herdr labels with the worktree's name for a worktree session. Name
  and place are mutable and collidable, so the session id is the stable
  address. `agents` joins herdr's `agent list` to `tab list` and
  `workspace list` (the caller's workspace by default, `--all` for the
  session, which adds the place column); `message` resolves a name
  (sender's workspace first, then the session), then a session id, then a
  place — addressing the one agent working there — to exactly one agent; a
  collision errors with candidates, never guesses, which is what makes a
  worktree an address exactly while a single agent holds it. Delivery is
  through `herdr agent prompt`, behind a prefix naming the sender by every
  address it answers to (identity from the pane env herdr exports). The prompt response's
  fresh status becomes the confirmation's delivery note: a working target
  queued the message behind its turn; a blocked one rejected it — the
  caller decides whether to linger (`--wait-unblocked`, the delivery
  attempt as the probe, retried until `--timeout`). There is deliberately
  no deliver-later queue. `skills/bus/SKILL.md` is the runbook agents
  load; agentstart's skills scan installs it.
- `confirm.ts` is the generic terminal safety boundary for keybindings: a
  two-row decision — the question, then right-aligned `Yes No` with only the
  selected word highlighted and Yes focused by default — followed by an exact
  argv spawn only after interactive confirmation. It owns no Herdr topology;
  the plugin's internal `close-active` command reads the pane entrypoint's
  captured context and phrases the public Herdr close command.
- `close.ts` is that narrow internal context bridge. It accepts only `pane`,
  `tab`, or `workspace`, requires the corresponding id in
  `HERDR_PLUGIN_CONTEXT_JSON`, and delegates the close to Herdr's CLI.
- `catalog.ts` consumes `agentlaunch x-catalog --x-json` for the slug
  pipeline's metadata level; the launch choice space is no longer this
  repository's concern.
- `conversation/` is the slug pipeline: `resolve.ts` finds the transcript
  by id-in-filename glob over the harness's native store (no index in
  between, so nothing can be stale); `extract.ts` reads the first
  substantive user prompt per store grammar (meta lines, sidechains,
  local-command output, and codex's injected instruction items are not
  prompts; housekeeping commands stand only when nothing else follows);
  `prompt.ts` holds the pure transforms — slash-command stripping,
  @-mention expansion against the transcript's cwd, center truncation, and
  keeper's slug normalization with its unsafe-text strip; `infer.ts`
  composes the non-interactive completion and runs it in the fixed
  `/tmp/agentsurface/inference` cwd so recorded sessions collect in one
  quarantined workspace. Inference names `agentlaunch` directly — the bare
  shims would exec the native binary under a session's AGENTLAUNCH_LAUNCH
  sentinel and drop the level.
- `state.ts`: the launch log of realized directives — bookkeeping, never
  authority. Project roots, priming, and the form's own state moved to
  agentlaunch with the form; agentsurface has no config file.
- `session-snapshot.ts` saves selected running local Herdr servers through
  public workspace/tab/pane/agent listings as one strict versioned JSON file
  per session, defaulting to the `default` server and the app's XDG state
  `session-backups` directory, and adding git branch/HEAD/dirty metadata for
  linked worktrees. When a newer Herdr client refuses the older running server's
  protocol, dump alone falls back to four read-only raw socket list methods;
  strict response envelopes and consumed fields are validated before capture.
  Resume accepts a snapshot path or resolves a session name in that default
  backup directory, targets the saved session name unless explicitly
  overridden, and is deliberately non-replacing: a target with running agents
  is untouched; an agent-free existing target keeps its persisted topology and
  resumes saved agents into matching panes, recreating a missing saved
  agent-bearing workspace beside it and republishing each saved tab label as
  the pane's conversation sidebar token; a missing target is fully rebuilt. A
  missing dirty worktree is refused because metadata cannot carry uncommitted changes.
- `plugin/` is the herdr plugin (id `agentsurface`), linked by agentstart's
  installer and the shared home for popup-bound fleet TUIs. Its `launch` pane
  entrypoint runs `agentsurface host -- agentlaunch --x-surface` in a
  session-modal popup; the host resolves the active pane's cwd and runs the
  form there. Its `usage` pane entrypoint runs `agentusage` through the
  escape-to-close wrapper; its `voice` pane entrypoint runs `agentvoice
  remote`, bare — that TUI spends esc on its own palette and quits on `q`,
  so the wrapper would close the popup instead of the palette. Popup titles
  follow one convention — the title-cased name of the CLI the TUI fronts:
  `Agent Launch`, `Agent Usage`, `Agent Voice`. Its three compact close
  entrypoints give AgentSurface's shared confirmation TUI stable titles and
  geometry while preserving the active topology ids in plugin context. Its
  `pane.agent_detected` and `pane.agent_status_changed` hooks both run
  `agentsurface name-tab`; `tab-namer.ts` publishes the `$project` sidebar
  token on detection and repairs it when a later status transition finds it
  missing (the root repository name plus the branch the pane's checkout has
  out — a linked worktree's or the repository's own — falling back to the
  workspace label off any repository), and each hook
  run is one
  bounded naming attempt: poll the pane for its agent session, claim the
  tab in the plugin's state directory, scoped by the Herdr session socket
  because public tab IDs repeat across named sessions (a `pending <pid>`
  state file, rewritten to `named <conversation-hash>` after the rename so a
  reused tab ID with a new harness session gets named again; a dead claimant's
  pending claim is taken over; an old claim migrates only when its tab already
  has a nonnumeric Name), and poll `conversation slug` while the
  transcript has no prompt — re-reading the pane's live session each round,
  so a crashed agent's replacement becomes the name source — then rename the tab. The
  windows cover machine lag only; a start stalled at a trust dialog or an
  agent idling unprompted expires the attempt, and the status transition
  that ends the stall re-arms a fresh one, however much later it comes.
  Failures release only a claim the namer still owns and reach only
  herdr's plugin log.

## Invariants

- A directive is executed exactly as written or refused exactly as
  received: strict parse, hard version gate, no defaults, no repair. The
  host never reorders, batches, or coalesces the stream.
- The launched process is herdr's, started by `herdr agent start` running
  the bare harness command — which is the fleet shim into agentlaunch. No
  harness binary is ever resolved or spawned by this repository; slug
  inference spawns `agentlaunch`, which owns that resolution.
- A bus message reaches its target only through `herdr agent prompt` —
  herdr's own typed-input path; this repository never writes to a pane.
  Delivery is not receipt: the confirmation carries the target's status so
  the sender knows a working harness queued the message.
- A hosted tool is a black box with a terminal: the host lends it the tty
  on stdin/stderr, the cwd, and the stdout pipe, and reads nothing back
  but directives and the exit code. Feedback about a directive's fate is the operator's (herdr
  notifications), never the tool's.
- A launch fails only when no harness ran. `herdr agent start` spawns and
  then waits to confirm the launch alias; every outcome of that wait —
  `agent_not_ready`, `timeout`, `agent_name_not_found` — is an unnamed but
  started launch, recorded with `named: false` and reported to nobody. The
  intent rides the argv, so the harness submits it on its own schedule. A
  genuine failure's notification names the spool file holding the prompt.
- A project already on the surface gets a tab in its workspace; a
  workspace is created only when none hosts the project. The project's
  basename must match the workspace label; a transient pane foreground cwd
  never gives an unrelated workspace ownership. Stable pane cwd only
  disambiguates duplicate labels.
- Launch records append to the state log; losing or garbling it only
  flattens the project ordering.
- Session resume never replaces a target session name Herdr already knows.
  The target defaults to the name stored in the one-session backup and may be
  overridden. Targets with running agents are no-ops; agent-free existing
  targets resume saved agents only after each agent-bearing pane matches the
  snapshot, recreating agent-bearing workspaces that are wholly absent;
  unrelated live topology is preserved.

## Validation

Before landing a change:

```sh
bun install --frozen-lockfile
bun run generate:schemas
bun run check
bash -n scripts/install.sh
```

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, Codex uses
  `$agent:<name>`, and Pi uses `/<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
