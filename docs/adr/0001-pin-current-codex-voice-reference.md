# Pin the current Codex voice reference

The reference contender uses Codex App-server 0.151.0, whose V3 default is `gpt-live-1-codex`; its subscription-backed endpoint rejects an explicit `session.model`, so the binary version is part of the model identity. Boulder was the default through 0.149.1, but the live service now rejects sessions created by that archived client, so it cannot provide a runnable baseline.
