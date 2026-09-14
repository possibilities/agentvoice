# AgentHUD frontend

The HUD is a read-only sibling web surface for durable work and current native
execution. It polls `GET /api/hud`, preserves the last successful snapshot when a
refresh fails, and keeps returned results, lead acceptance, and human presentation
as separate visible states. Native counts marked with `≥` are observed minimums;
unavailable observation never becomes a zero or a completion claim.
Closed audit disclosures preserve Work authority and relations, assignment contracts
and exact bindings, plus returned, review, and presentation evidence. Only `http:`
and `https:` evidence references become links; every other reference remains text.

```sh
npm ci
npm run check
npm test
```

`npm run build` writes static assets to `dist/`. Browser fixtures cover complete,
partial, unavailable, dense hierarchy, narrow viewport, and refresh-failure states.
Their review screenshots are written below `test-results/screenshots/`.
