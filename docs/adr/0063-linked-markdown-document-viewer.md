# 0063: Linked Markdown document viewer

Accepted 2026-09-14 at the operator's request. Extends the shared transcript
presentation boundary without changing native session or action authority.

## Context

Assistant replies contain ordinary external URLs alongside Markdown paths in the
wiki, work vault, workspace and project documentation. The shared renderer opened
all links as new targets; local filesystem paths did not have a browser document
route. A useful viewer needs host resolution without exposing a general file API.

## Decision

AgentChats supplies an opt-in document provider with an injected loader. Recognized
local Markdown links open a reading dialog using the existing typography, code
highlighting and tables. Back, Close and keyboard navigation preserve the underlying
transcript and composer. The original target and canonical source path remain
inspectable. External web and mail links retain ordinary browser behavior; document
content cannot execute HTML or cause the host to fetch remote resources.

AgentVoice supplies a same-origin POST endpoint for linked Markdown only. The
browser can submit a link and an optional previously served document path; it
cannot choose roots or native endpoints. Initial documents must be linked from
assistant content in the current verified transcript. A relative follow-up must
be linked from a document already served in that view. Paths are provenance, not
capabilities: server-side grants and containment checks authorize every read.

Allowed roots are the verified workspace, authored wiki/work vault, and exact
project roots derived from already-linked documents. Only Markdown regular files
are readable, with bounded UTF-8 content. Hidden descendant components, symlinks,
traversal outside a granted root, network targets and unsupported formats are
refused. Session replacement invalidates grants; document reading never creates
a native session, sends text or reconnects media.

## Consequences and verification

This is a document-link viewer, not a file browser or a remote-page proxy. Missing,
unlinked, disallowed, oversized and invalid documents produce visible errors.
The platform's storage and filesystem permissions still apply. Tests must cover
origin/schema enforcement, linked grants, traversal/symlinks, replacement,
relative navigation, unsafe content, keyboard/focus and draft continuity. Rendered
wide/narrow fixtures and actual served-code verification establish delivery;
native server or kiosk restart remains a separate action.
