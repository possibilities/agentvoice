# AgentVoice transcript UI

This directory owns AgentVoice's transcript renderer, composer, Codex presentation
adapters, and their supporting components, types, and utilities. The implementation
was transferred from the MIT-licensed AgentChats transcript package at commit
`4778b88ee513e933ba8c66ec1b2cfd95f13b7adf` (package version 0.3.13).

The public entry points retained for internal use are:

- `transcript/index.ts`: provider-neutral message types and data helpers.
- `transcript/react.ts`: transcript, composer, document viewer, and live hook.
- `transcript/codex.ts`: Codex source and presentation adapters.
- `transcript/{theme,presentation,styles}.css`: readable style sources.
- `styles.css`: generated scoped output used by AgentVoice. Run
  `npm run transcript:styles` after editing the sources; the normal build rejects drift.

Keep source, dependencies, and focused browser regressions in this repository. Do
not restore a packed archive or a cross-checkout import from AgentChats.

The `.agentchats-transcript` CSS class and `@agentchats/transcript:composer:*`
browser-storage keys remain compatibility identifiers. Retaining them preserves the
accepted scoped CSS byte output and existing recovered AgentVoice drafts; neither
identifier loads or communicates with AgentChats.

The transcript has one full detail surface: callers cannot hide native activity,
and source adapters do not carry a messages-only query or filter. Its top-level
types are Human, Agent, and generic Tool call. All machine events use that one
Marker/activity-disclosure shell, with Attachment primitives permitted only as
specialized inner details. No separate event card registry or special compaction UI
exists. Eligible consecutive ordinary, file-change, and historical routing tools
collapse behind a counted disclosure; expansion renders those same generic Tool
call blocks without horizontal rules. Native file operations retain
their order, status, paths, counts, lazy Pierre diffs, original projected evidence,
and honest unavailable/truncated fallbacks without reading workspace files.

Subagent lifecycle projections receive no web presentation; direct worker results
keep their normal conversation delivery. Voice-originated Human messages retain
their internal provenance and complete details behind the microphone button beside
the author without rendering a second source label. See
[ADR 0105](../../../docs/adr/0105-compose-transcript-events-from-primitives.md) and
[ADR 0106](../../../docs/adr/0106-restore-compact-tool-activity-groups.md).

The copied component boundary retains scoped lint exceptions for existing
interaction roles, effect dependencies, and positional rendering keys; migration
does not rewrite those accepted behaviors. Readable CSS preserves its source
formatting so regenerated output stays byte-identical to the transferred baseline.
