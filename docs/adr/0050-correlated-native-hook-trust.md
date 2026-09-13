# 0050: Correlate native TUI hook trust to its current inventory

Recorded September 12, 2026. Extends [ADR 0022](0022-websocket-native-tui.md)'s
native TUI interaction and exact operation whitelist for Codex 0.154.0 hook
review. It does not broaden full access, approval policy, account management or
general native configuration writes.

The stock TUI now calls `hooks/list` before resuming a remote thread. When an
untrusted or modified hook is present, the human may review it, continue without
trusting, or explicitly trust the displayed hooks. Trusting sends one
`config/batchWrite` upsert for `hooks.state`; this is separate from the command
approval and filesystem/network sandbox selected by AgentVoice full access.
Rejecting every config write prevents the explicit native trust choice from
completing and leaves the startup review prompt active.

The attachment gateway records only untrusted or modified hook key/current-hash
pairs returned by the native `hooks/list` response to that same peer for the exact
selected workspace. It forwards only the stock trust write shape: one
`hooks.state` upsert, no alternate file or expected version, native config reload
enabled, and every trusted hash exactly matching that recorded inventory. No
attachment can set arbitrary config, enable or disable hooks, trust an unknown or
changed hash, or reuse another peer's inventory. Native Codex still owns the
durable config write and its validation. Starting another `hooks/list` invalidates
the prior inventory even if that refresh fails, and one matching trust attempt
consumes it.

The correlation matters because a controller attachment ticket is a local
capability but not proof that every client-authored hash describes a hook the
human just reviewed. A broad `config/batchWrite` pass-through would escape the
selected-thread boundary and let the attachment mutate unrelated native settings.
Disabling hook review or passing `--dangerously-bypass-hook-trust` would instead
run untrusted hooks without the native human decision and is not an acceptable
full-access shortcut.

Validation used stock Codex 0.154.0 with a disposable HOME/CODEX_HOME/workspace,
localhost fake Responses provider, external network denied, a harmless
`/usr/bin/true` hook and no audio or hosted inference. Continue without trusting
and review both reached the resumed thread. After the boundary change, trust all
wrote the correlated hash, reached that thread and suppressed the prompt on the
next attachment. Protocol tests prove the write is denied before `hooks/list` and
reject alternate paths, unrelated keys, unknown hooks and mismatched hashes. The
real no-media three-pane smolmux composition remained open after Escape dismissed
the review and after trust-all completed.
