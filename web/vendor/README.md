# @agentchats/transcript 0.1.2

Packed from [agentchats main 40ac3f3](https://github.com/possibilities/agentchats/commit/40ac3f3),
based on the requested `e973c55` foundation. MIT license is inside the archive.
Two first-consumer fixes landed upstream:

- `94e45fc`: optional message timestamps; unknown native times render without a clock.
- `40ac3f3`: scoped transcript root flex sizing in a column host, with overflow/follow regression coverage.

Reproduce from that clean agentchats revision:

```sh
npm --prefix web ci
npm --prefix web run build:package
cd web
npm pack --workspace @agentchats/transcript --pack-destination /path/to/agentvoice/web/vendor
```

AgentVoice installs the archive through `web/package-lock.json`, including its
integrity hash. No runtime source link or agentchats database adapter is used.
