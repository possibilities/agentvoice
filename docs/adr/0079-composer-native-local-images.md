# 0079: Clipboard images use native local-image input

Status: Accepted; [0102](0102-agent-only-web-transcript.md) removes the picker and
visible submit/mode controls while retaining clipboard image behavior.

Partially supersedes [0078](0078-composer-local-file-references.md): ordinary file
references remain editable text; raw clipboard bitmap paste now has its own local
image workflow.

## Context

The operator expects pasted screenshots to behave like installed Codex. Inspection
of Codex CLI 0.154.0 and its local source establishes that clipboard images become
retained local files, appear as atomic `[Image #N]` attachments, and are submitted
as `localImage` inputs separately from text. Merely inserting a path into text does
not provide those native image semantics.

## Decision

Keep the host file picker and ordinary file drops as editable `@/absolute/path`
references, as explicitly requested. When clipboard paste supplies image bytes
without a usable absolute path, save those bytes through a guarded local endpoint.
Show numbered, individually removable image attachments outside the text field.
Send, Steer and Queue carry only ordered `{path}` metadata in their control request;
the exact-thread gateway emits native `{type:"localImage", path, detail:null}`
parts before nonempty text. Native Codex owns image decoding/preparation and model
transport. AgentVoice does not call a Files API or create remote upload objects.

The local save accepts PNG, JPEG, WebP and GIF with matching content signatures,
up to 10 MiB each and four images per message. The verified workspace and thread
own `.agentvoice-images/<thread-sha256>/<request-uuid>.<validated-extension>`.
Directories are private (0700), files private (0600), writes exclusive and atomic,
and request IDs make equal-byte retries idempotent. Symlinks, traversal, arbitrary
paths and foreign thread images are rejected. Admission and dispatch revalidate
files. Stream limits, bounded directory scans, concurrent-save bounds and a
256 MiB per-thread quota bound retained resources.

Retain completed image files across send, removal, cancellation and reader restart
so a persisted draft, queued item or history reference does not lose its source.
Removing an attachment changes the draft only. Incomplete/cancelled writes are
cleaned up; abandoned private temporary files older than one hour are reclaimed
on a later save. Completed files live with the workspace; automatic age-based deletion
would make offline browser drafts unsafe, so cleanup is explicit workspace
maintenance. Quota exhaustion reports an error instead of deleting old sources.

Drafts, recovery records, queue edits and optimistic messages preserve ordered
image path metadata; the browser never persists image bytes. Native image echoes
render as numbered placeholders while retaining message text and reconciliation
identity. Binary/base64 native echo content is removed before browser projection.

## Consequences

Image-only messages work, and saving an image is distinct from submitting a turn.
A failed save or cancelled paste preserves text and already attached images.
Newer drafts survive failed submissions. A phone browser pastes its image to the
AgentVoice host's private workspace storage; selected host files remain references.
No thumbnail fetch or image preview cache is introduced in this slice.

The dedicated local materialization request necessarily carries bounded raw image
bytes. Composer control/native input requests carry paths only. Existing loopback,
origin and exact-view guards remain required; no native transport size limit grows.
