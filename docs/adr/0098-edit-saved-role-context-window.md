# 0098: Explicit saved context-window edits

Accepted September 19, 2026. Extends [ADR 0042](0042-workspace-role-databases.md)
with one additional typed, saved-only setting mutation.

An existing bound workspace deliberately ignores subsequent global config edits.
Consequently, increasing AgentStart's default context window does not affect its
saved role or the native resume request. Preserve that ownership boundary rather
than merging global defaults into authored snapshots.

Add `role context-window` with a positive native token budget or explicit clear,
required expected revision, and read-only dry-run. Validate the complete candidate
before publishing; transactionally check role identity and revision, retain the
immutable history and exact asset manifest, and reject masking raw config.
Status exposes the saved value. Native Codex remains the authority for model
clamping and usable-context headroom.

The operation only saves. It starts no inference, changes no session marker,
and performs no lifecycle action. A separately authorized runtime replacement
loads the revision and resumes the exact existing thread. General settings editing
and live context changes remain outside this bounded extension.
