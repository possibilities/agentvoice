# 0077: Preserve bounded transcript content summaries

Accepted 2026-09-15. Refines [0023](0023-conversation-observation.md),
[0057](0057-responsive-web-transcripts.md), and [0075](0075-own-web-transcript-ui.md).

## Problem and decision

Native command and tool items commonly carry results far larger than the 64 KiB
conversation-event limit. Replacing the whole item with a generic oversized
placeholder discarded its tool name, actual status, exit code, and concise error
fields. The web renderer then treated every unavailable item as an error, so
completed tools appeared failed. Current root history contained 102 such rows;
their native items ranged from roughly 69 KiB to 2.6 MiB and all 102 were actually
completed.

Keep the bounded transport and native-history receive limits. When a known item
cannot fit, publish an explicit unavailable item with a bounded `omission` summary:
original and item-limit bytes, native type, tool name/detail, status, exit code,
failure type/message/details, and a safe text excerpt when traversal permits it.
Media remains omitted and receives no excerpt. The final item reserves room for
its event envelope.

Omission and execution status are independent. The reader renders a completed
tool with omitted bulk content as completed. It renders failure styling only when
the preserved native status reports a real failure. Expanded details show failure
context separately from the size/reason notice and excerpt.

History pagination also observes the public byte budget. It stops before adding
an item that would overfill a response and returns a continuation cursor, rather
than rejecting a mixed page whose individually bounded items are valid.

## Consequences

The normal transcript remains bounded in controller memory, event frames, history
responses, browser JSON, and disclosure content. AgentVoice still does not become
a transcript database or binary/media retrieval service. A bounded summary is not
full fidelity; native history remains authoritative. A future full-detail reader
would require its own exact-identity, chunked, bounded contract.

Protocol, history, reader, and browser regressions cover completed and failed
oversized tools, error preservation, media omission, byte-budget continuation,
and visible distinction between tool failure and omitted bulk content.
