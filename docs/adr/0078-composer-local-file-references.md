# 0078: Composer file references remain editable text

Status: Accepted

## Context

The web composer needs the convenience of selecting or dropping a local file,
including an image, while preserving Codex-style `@/absolute/path` input. Browser
file selection usually exposes a filename, not a trustworthy absolute path.
Treating that filename as a path or uploading its bytes would change the requested
meaning and the existing exact-root text gateway.

## Decision

Add one **Reference a file** control. Its host-side picker reads bounded directory
metadata under the reader process's home folder and inserts the selected absolute
path prefixed with `@` at the composer's current selection. The resulting reference
is ordinary editable text, including spaces; no hidden attachment state or chip
model needs to be reconciled with a draft.

A drop or paste that exposes absolute path text, a local `file://` URI, or a host
file object's absolute path inserts the same reference. A filename alone, relative
path or raw clipboard bitmap cannot establish a host path. Show an explanation and
point to the picker; never read, upload or save its bytes. The picker describes its
host location explicitly, including when used from a phone browser.

The metadata endpoint retains loopback-peer, exact-origin, same-origin POST/JSON
and no-cache protections. It returns bounded visible regular files/directories,
excludes hidden paths, symlinks and special files, and does not read file contents.
Users can still type absolute references outside the picker scope. Selecting a
file grants no additional filesystem or native runtime authority: native Codex
receives the existing text input and applies its own configured permissions.

## Consequences

Send, Steer, Queue, editing, draft persistence, failed-input recovery, optimistic
reconciliation and native transcript history keep the existing text semantics.
There are no binary request bodies, changes to native input schemas, upload stores,
preview image fetches or new transport size limits. Referenced files remain at their
original paths; moving or deleting one can make the reference unavailable later.

The picker is useful on desktop and narrow screens without a native desktop dialog.
It is intentionally limited to visible files in the host home tree. Browser-hidden
paths and raw bitmap paste are explicit limitations, not an upload fallback.
