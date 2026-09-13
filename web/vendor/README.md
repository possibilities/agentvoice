# @agentchats/transcript 0.1.3

Packed from [agentchats main 338789f](https://github.com/possibilities/agentchats/commit/338789fb1129),
based on the requested `e973c55` foundation. MIT license is inside the archive.
Two first-consumer fixes landed upstream:

- `94e45fc`: optional message timestamps; unknown native times render without a clock.
- `40ac3f3`: scoped transcript root flex sizing in a column host, with overflow/follow regression coverage.
- `338789f`: follows updates while near the bottom, counts new messages while reading earlier text,
  and supplies the shared jump-to-latest chip; corrects packaged transcript canvas styling.

Reproduce from that clean agentchats revision:

```sh
npm --prefix web ci
npm --prefix web run build:package
cd web
npm pack --workspace @agentchats/transcript --pack-destination /path/to/agentvoice/web/vendor
```

AgentVoice installs the archive through `web/package-lock.json`, including its
integrity hash. No runtime source link or agentchats database adapter is used.
