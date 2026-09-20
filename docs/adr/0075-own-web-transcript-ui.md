# 0075: Own the web transcript UI in AgentVoice

Accepted 2026-09-15 at the operator's request. Refines the source boundary in
[0057](0057-responsive-web-transcripts.md), [0058](0058-durable-web-composer-and-reader-recovery.md),
[0063](0063-linked-markdown-document-viewer.md), and [0064](0064-browser-presentation-preferences.md)
without changing their accepted behavior.

## Decision

AgentVoice owns its transcript UI source under `web/src/transcript-ui/`: the
provider-neutral message model and merge/group helpers, Codex presentation/source
adapters, React transcript/composer/document components, supporting controls,
types, utilities, and styles. The transferred baseline is the MIT-licensed
AgentChats transcript package 0.3.13 at commit `4778b88`, including settled
per-row disclosure measurement that preserves other cached window heights.

AgentVoice depends directly on the runtime libraries used by this source. It has
no `@agentchats/transcript` package, vendor tarball, cross-checkout import, package
build indirection, or runtime AgentChats dependency. The historical CSS root class
remains an internal selector so the accepted scoped stylesheet stays byte-equivalent.
Historical `@agentchats/transcript:composer:*` browser-storage keys also remain so
existing AgentVoice drafts survive the source transfer. These are compatibility
identifiers only; they do not load or communicate with AgentChats.

Readable style sources and an AgentVoice-owned compiler produce the checked-in
scoped stylesheet. Normal web builds reject stylesheet drift. Property definitions
and keyframes remain document-level; every selector rule remains inside the
transcript scope, preserving host CSS isolation.

Amended 2026-09-16: AgentVoice has one transcript detail surface. The renderer,
live hook and retained Codex adapter always carry the full observed transcript;
there is no messages-only filter, detail prop/type, detail-scoped cursor or row
incarnation, caller-selectable HTTP detail query, or fixture control. The retained
Codex source adapter pins `detail=full` because its source API defaults omission to
messages-only. This matches the live app, which has never offered a detail selector
and needs native activity for its disclosures and system cards.

## Consequences

Transcript fixes, dependencies, tests and releases now move with AgentVoice. The
repository keeps focused data-helper and direct-component fixtures in addition to
the host integration suite. The 2,000-row bound, disclosure state, exact settled
row sizing, host-style isolation, composer recovery, document reading, and current
Agent-only transcript/dock behavior remain regression requirements. [ADR 0102](0102-agent-only-web-transcript.md)
removes the raw Voice lane and pane preferences.

AgentChats retires its web reader and transcript package while retaining its CLI,
index, MCP, and OpenTUI surfaces. Future sharing requires a new explicit product
boundary; copying an archive or linking another checkout does not update AgentVoice.
