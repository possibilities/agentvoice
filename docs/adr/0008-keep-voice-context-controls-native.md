# 0008: Keep voice-context controls native

Accepted 2026-09-04.

AgentVoice adds no transcript-replay layer between voice sessions. Keep
`include-startup-context` and `flush-transcript-tail-on-session-end` optional:
omitted means omitted on the wire, explicit booleans pass through unchanged.
Keep `experimental_realtime_ws_startup_context` reachable through
`orchestrator.config`, preserving empty strings and generic passthrough precedence.
The shipped example remains a no-op. This decision adds no runtime default.

Codex currently enables the startup snapshot for our WebRTC transport and
disables end-of-session tail flush by default. Disabling the snapshot skips
its generated or replacement text; it does not erase native thread history or
prevent an orchestrator from recalling earlier work. Tail flush is independent:
enabling it may cause an orchestrator turn after hangup, while ordinary
delegations can carry transcripts regardless. Docs and schema descriptions
must make these boundaries explicit, without promising session isolation.

This does not ratify the current app-wide `thread.json` selection policy as
vanilla continuation. The requested replacement is cwd-local native session
selection: continue the latest voice session by default, `--no-continue` for a
new session, and `--resume <id>` for a specific session in that cwd. Its launch
and Server ownership design is a separate implementation sketch. Those flags
are not introduced by this decision.

Verification covers optional booleans, independent values, empty/nonempty
startup overrides, config/extra precedence, and preservation of explicit
prompt/seed files. No installation, restart, history rewrite, global config
change, or new inference probe is part of this pass.
