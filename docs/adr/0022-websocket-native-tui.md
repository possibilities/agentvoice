# 0022: WebSocket-only RPC and native TUI interaction

Accepted 2026-09-06. Supersedes ADR 0021's opt-in transport, full-access admission
gate and suppression of native human requests. Extends ADR 0020's native
permission defaults. The operator approved always-available stock TUI attachment,
removal of both attachment flags, and native human interaction through the TUI.

Every runtime starts its owned, unmodified Codex app-server on an authenticated
ephemeral loopback WebSocket. AgentVoice and each gateway-backed TUI use separate
native WebSocket connections. Stdin/stdout no longer carry RPC; stdout/stderr
remain process diagnostics and listener startup discovery. There is one native
transport implementation, with the existing owned-process shutdown contract.

`agentvoice attach agent [--workspace <dir>] [--thread <id>]` is always available.
Neither `--allow-tui-attach` nor `--no-tui-attach` exists, and attach accepts no
full-access flag. Ordinary voice launch still accepts optional
`--allow-full-access` as an explicit native permission override. Restricted and
unreported permissions do not prevent attachment or revoke it. The launcher
does not force danger-full-access/never on the stock TUI.

Joining preserves the live thread: the gateway forwards `thread/resume` with
only thread identity and history paging fields. Stock TUI local startup defaults
must not replace live permissions, prompts or model settings. Subsequent explicit
`thread/settings/update` and native turn options retain their native semantics,
including permission changes. Exact workspace/thread checks remain.

The native human-request methods forwarded for the selected thread are:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

AgentVoice shows an interaction notice and sends no answer to these methods. Native
Codex holds each pending request and broadcasts it to subscribers; the first
answer resolves the shared callback. It replays pending requests when a client
resumes the thread. A TUI disconnect therefore leaves the question pending in
native Codex. AgentVoice owns no approval queue, persistence, timeout or invented
answer. The gateway keeps only a bounded set of forwarded IDs so unsolicited
answers cannot cross the boundary, and clears them on native resolution or
disconnect. Both native result and error answers pass through.

Unsupported client-defined tools, auth callbacks, legacy v1 requests and unknown
methods keep their visible refusal/error behavior. Retired custom worker calls
still fail promptly. This does not add handlers for client-defined tools or
account management.

The private native credential, one-use watcher/TUI grants, controller identity
checks and selected-thread operation whitelist from ADR 0021 remain. There is
no arbitrary endpoint or cross-machine attachment mode. Fresh, restart, native
loss and quit revoke attachment before teardown; redial preserves it. Watcher
loss terminates the TUI to prevent reconnect from replaying input. An ordinary
TUI detach leaves voice and native work running.

The attachment launcher tracks its owned process descendants because a configured
Codex executable can launch through wrappers. Revocation, watcher loss and launcher
termination stop that entire observed tree, escalating to SIGKILL after a bounded
grace period. Cleanup continues after an intermediate wrapper exits, before the
launcher restores terminal modes. A normal watcher close permits a brief graceful
TUI exit but cannot leave an indefinitely running client.

Validation used stock Codex 0.153.4 with a disposable HOME/CODEX_HOME/workspace,
localhost fake Responses API, external network denied and no audio. The stock
TUI displayed an approval raised before attachment on a workspace-write/on-request
thread, accepted it, showed the command output and continued the turn. A second
pending approval survived TUI termination and reappeared on reattachment. Fake
protocol tests cover all five human methods, result/error forwarding, stale and
unsolicited answers, preserved resume settings, lifecycle and WS-only owned-child
behavior. The earlier live trial confirmed typed steering with audible voice;
it did not validate the new permission flows with live audio.
