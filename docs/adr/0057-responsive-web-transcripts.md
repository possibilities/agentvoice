# 0057: Responsive web transcripts with correlated submissions

Accepted 2026-09-14 at the operator's request. Refines the web input presentation
in [web agent input](../web-agent-input.md); exact-thread authorization and native
execution ownership remain with the existing attachment gateway.

## Decision

The web host preserves unchanged message and lane identities across full JSON
polls. The shared transcript always renders the full observed item surface and a
measured window of message blocks instead
of mounting all history and measuring every child on each scroll. Tool disclosure
state belongs to stable message identities above grouping and windowing, so
streaming, prepends, and temporary unmounts retain the reader's choices.

The host serves large live snapshots with gzip and an explicit ETag. The browser
retains that validator and accepts `304 Not Modified`, avoiding retransmission of
the same bounded history on every poll. Connection health remains time-bounded
until response headers arrive. Once the local reader accepts a response, its body
receives a separate generous deadline so a large history cannot be discarded
repeatedly while the centered history-loading state hides both panes. The first
nonempty lane also bypasses deferred presentation, preventing an empty same-call
snapshot released by the server's initial history budget from starving the first
complete batch.
Any failed read clears the validator because the browser's unavailable state is a
local projection that must be replaced by an authoritative response body.

The composer always presents Send, disabled when its selected action is unavailable.
Working occupies the upper-right composer gutter. Submitting clears only that
submitted draft immediately and projects a local message or queue row while the
request is pending. New typing remains independent of the pending request.

The browser's request UUID is also the native `clientUserMessageId`; native user
items render with their echoed client identity. Exact identity reconciles local
rows with authoritative content and order. Text equality is never an identity.
Definitive rejection removes the local row and retains a recoverable draft;
ambiguous delivery retains an explicit unknown state without automatic replay.
A native echo observed before an HTTP failure is authoritative acceptance.
Editing a queued row assigns a fresh native client identity while preserving its
queue identity and FIFO position, including after an earlier ambiguous dispatch.
Call-incarnation replacement fences all local submissions and delayed responses.

Development serving remains the editable default, with prepared production serving
optional. Before the fix, production still suffered full-history scroll/layout
work. After identity preservation and windowing, the 2,000-message development
probe mounted 19 rows (240 DOM nodes), with typing paint p95 of 12ms and streaming
paint p95 of 17.5ms. These synthetic measurements support fixing rendering itself;
they do not require a fleet-wide serving-mode change.

## Consequences

Rendering work scales with visible message blocks. A single expanded activity
block can still contain many tool details; its contents are not individually
windowed. Browser text search sees mounted history, while native transcript data
remains complete. Initial placement, scrolling anchors, unread tracking, tool
expansion, input focus and composition require browser regression coverage.

Optimistic rows are transient presentation, not persisted native history. The
server remains authoritative for accepted input, queue state and corrections.
Failed draft recovery never silently overwrites newer typing. Installation and
build preparation do not authorize restarting an active app or call.
