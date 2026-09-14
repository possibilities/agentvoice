# @agentchats/transcript 0.3.4

Packed from [agentchats b2e0511](https://github.com/possibilities/agentchats/commit/b2e05114b2d7636f1c201ccd4376bb6dbd0d5ec3),
based on the requested `e973c55` foundation. MIT license is inside the archive.
Consumer fixes and shared features landed upstream:

- `94e45fc`: optional message timestamps; unknown native times render without a clock.
- `40ac3f3`: scoped transcript root flex sizing in a column host, with overflow/follow regression coverage.
- `338789f`: follows updates while near the bottom, counts new messages while reading earlier text,
  and supplies the shared jump-to-latest chip; corrects packaged transcript canvas styling.
- `b77c32c`: standalone Agent composer with queue/steer/interrupt affordances and awaited
  queue editing; omits the follow chip in empty and non-overflowing transcripts.
- `2eb84b4`: readable Codex voice handoffs with original-content disclosures, wider
  columns and tighter spacing, complete tool details, and composer label/focus polish.
- `f9036ac`: modal voice-message inspection with complete source context, optional
  passive Working status, and aligned composer inner padding.
- `e6bea54`: larger monospaced reading and composer text, an 80ch prose cap inside
  the 1120px outer column, compact gaps and at least 44px composer touch controls.

- `cc47e4e`: optional measured transcript windowing, stable disclosure and Markdown
  identities, always-visible Send, separate Working status, optimistic submission
  metadata and recoverable drafts. Preserves the inherited console theme.
- `b2e0511`: retains exact reading anchors when varied-height history is prepended,
  with bounded retries until the saved row is mounted and measured.

Archive SHA-256: `b16d16ac6ede815a26329d8c790bbbe8efb245c377bb3fdce20b50489a294fe3`.

Reproduce from that clean agentchats revision:

```sh
npm --prefix web ci
npm --prefix web run build:package
cd web
npm pack --workspace @agentchats/transcript --pack-destination /path/to/agentvoice/web/vendor
```

AgentVoice installs the archive through `web/package-lock.json`, including its
integrity hash. No runtime source link or agentchats database adapter is used.
