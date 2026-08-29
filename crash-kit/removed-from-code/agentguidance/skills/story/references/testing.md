# Forward tests for this skill

Seven graded tests against the legacy AgentVoice repository, which is the
corpus these cases were written and calibrated against. It is archived and no
longer developed, but it is still a checkout — find it at
`~/archives/agentvoice`, and read every path below relative to it. Run them
when changing this skill: T1 and T5 are the minimum acceptance pair (the floor
and the default scope); the rest cover the remaining kinds and the refusal
edge.

Run each test in a fresh, independent context with a raw user-style prompt
and the built skill — without leaking these expectations or any design
conclusions into the prompt. Divert vault writes with `AGENTWIKI_VAULT`
pointed at scratch space so test runs never pollute the real `~/wiki`.

| id | scope instruction | what it tests | pass criteria |
| --- | --- | --- | --- |
| T1 | `src/content/root.ts` | the floor | at most ~1,200 words; every export in the appendix; reads as prose, not a padded list |
| T2 | `src/client/lib/voice-client.ts` | a rich file | every export plus the failure paths as `flow:` units; a reader can answer "why does the hero mic button refuse after a hard failure?" |
| T3 | `src/docs/` | a subsystem with existing docs | links to `docs/DOCUMENT-STORE.md` instead of paraphrasing it; the three leases as `inv:` units; teaches the lock-order story |
| T4 | "the mute controls" | a cross-layer feature | handoffs across `surface-layout.ts`, the component, the tests, and `docs/SURFACE.md` enumerated; the two controls' different semantics distinguished |
| T5 | *(no scope)* | the whole project | at most ~8,000 words despite repo size; proportional coverage at component grain; names candidate sub-stories rather than shallow-covering everything |
| T6 | "the payments module" | refusal | asks or reports absence; invents nothing |
| T7 | "`bun run verify`" | the `other` kind | units are the contract's properties (budget, ceiling, cleanup reserve, bounded output, no-retry, zero-tests-fails) from `src/verify.ts` and the repository instructions |

## Judging protocol

The same four checks for every test:

1. **Coverage.** An independent second enumeration of the subject, made
   without reading the story, diffed against the story's appendix — misses
   are coverage failures.
2. **Length.** Within the band for the kind (schema.md § Length calibration);
   the ceiling is absolute.
3. **Reader test.** Three "why" questions set before reading must be
   answerable from the story alone.
4. **Craft.** No section-per-function-in-file-order structure; every unit's
   consequence stated; a through-line present from the first paragraph to the
   last; links in the portable form (no `file://`, no branch-head permalinks,
   pinned commit stated in the provenance block).
