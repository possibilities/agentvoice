# clispeak agent notes

- The usage parser (`src/translate/usage.ts`) reads the *shape* of help
  text, not prose: `Usage:` headers, two-space entries, flag lines. A CLI
  whose help breaks that shape needs its `help.txt` edited by hand, not a
  smarter parser — the help text is an input the operator iterates on.
- The grammar is generated from the help on every reload and never
  hand-written. If the model emits something wrong, the fix is in the
  profile's `help.txt` or `workflow.md`, or in the generator — not a
  profile-specific `.gbnf`.
- `draft set <id>` is a real fmx finding: the id is assigned by fmx and was
  never spoken. The grammar allows the literal `<id>` and the TUI badges it
  "needs state". Do not paper over it in the workflow prompt.
- `--text` loads only the LLM; `--pipe`/TUI load VAD+STT and open the mic
  unless `--wav` replays a file. `sherpa-onnx-node` is `require`d lazily for
  that reason.
- Mic capture is `rec` (sox) streaming s16le; the agentvoice miniaudio FFI is
  the known second `MicSource` if in-process capture is ever needed.
- Models live outside the repo; see `resolveModelsDir` in `src/profile.ts`.
- Execution is TUI-only and opt-in twice: the profile must declare `[exec]`
  and the human must press `a`. `--pipe` and `--text` never execute; keep it
  that way — the pipe is the composition seam. The executor (`src/exec.ts`)
  fills `<placeholders>` from earlier commands' JSON output by key name.
- Keep the TUI plain: default terminal colors, bold for the newest
  translation, dim for history. No palette, no command palette.
