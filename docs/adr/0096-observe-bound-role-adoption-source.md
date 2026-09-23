# 0096: Observe a bound role's configured adoption source

Accepted 2026-09-17 for workspace-role freshness inspection. Extends
[0069](0069-directory-role-content-status.md) and
[0083](0083-adopt-directory-role-revisions.md) without changing immutable
workspace-role ownership.

For a database-bound workspace, `role.loaded` identifies the revision used by
the active runtime and `role.desired` identifies the database head. Equality
only proves that the runtime loaded the current immutable database revision. It
does not say whether a directory role currently selected by launch configuration
has newer guidance. Treating those revision fields as source freshness hid an
outdated generated cache after the then-named AgentStart manager role changed.

Runtime preflight now best-effort resolves the original launch configuration for
the exact bound workspace. When it still selects a directory role, the candidate
reports that path as an adoption source and computes the loaded content digest
from the database snapshot. The retained controller exposes
`role.adoptionSource`: the candidate path, loaded generation/revision/digests,
current source digests, and `stale` or a fixed bounded error. Status rereads only
the recorded path's effective prompt, MCP, and skills inputs. It never returns
their bodies or filesystem errors.

This comparison uses content that an immutable database snapshot can represent.
Empty skill directories and unrelated root files are omitted; files, logical
paths, skill directory ancestry, resolved bytes, and skill executable bits use
the existing `agentvoice-role-content-v1` framing. That avoids claiming a stale
adoption source for an empty directory that capture and projection discard.

The field is advisory. Bound launches continue to read only the database, and
generated cache trees remain disposable projections rather than authoring
surfaces. A stale result never adopts, reloads, or mutates anything. Adoption
still requires `agentvoice role adopt` with the current revision, followed by an
explicit activation boundary. Source discovery is best effort: missing or
invalid launch configuration, a different configured workspace, or no configured
role omits the field. Source bytes are reread for each status request, while a
changed selector becomes visible only after a successful runtime preflight.

Control protocol 9 adds this optional status field. Read-only discovery retains
protocols 5 through 8 so a newly installed web reader and thread monitor can
continue observing an older loaded controller. Existing controllers need an
explicitly authorized server restart to expose the field; runtime-only restart
cannot replace retained controller code.
