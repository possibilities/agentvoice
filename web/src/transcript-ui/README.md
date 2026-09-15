# AgentVoice transcript UI

This directory owns AgentVoice's transcript renderer, composer, Codex presentation
adapters, and their supporting components, types, and utilities. The implementation
was transferred from the MIT-licensed AgentChats transcript package at commit
`4778b88ee513e933ba8c66ec1b2cfd95f13b7adf` (package version 0.3.13).

The public entry points retained for internal use are:

- `transcript/index.ts`: provider-neutral message types and data helpers.
- `transcript/react.ts`: transcript, composer, document viewer, and live hook.
- `transcript/codex.ts`: Codex source and presentation adapters.
- `transcript/{theme,presentation,styles}.css`: readable style sources.
- `styles.css`: generated scoped output used by AgentVoice. Run
  `npm run transcript:styles` after editing the sources; the normal build rejects drift.

Keep source, dependencies, and focused browser regressions in this repository. Do
not restore a packed archive or a cross-checkout import from AgentChats.

The `.agentchats-transcript` CSS class and `@agentchats/transcript:composer:*`
browser-storage keys remain compatibility identifiers. Retaining them preserves the
accepted scoped CSS byte output and existing recovered AgentVoice drafts; neither
identifier loads or communicates with AgentChats.

The copied component boundary retains scoped lint exceptions for existing
interaction roles, effect dependencies, and positional rendering keys; migration
does not rewrite those accepted behaviors. Readable CSS preserves its source
formatting so regenerated output stays byte-identical to the transferred baseline.
