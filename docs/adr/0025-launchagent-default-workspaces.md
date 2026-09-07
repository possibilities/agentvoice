# 0025: LaunchAgent and default workspace generations

Accepted 2026-09-06. The macOS editable installer now installs the owned
`io.arthack.agentvoice.server` user LaunchAgent, which starts the waiting server at
login and restarts it on exit; `--command-only` keeps disposable command installs
and non-service use explicit. The server still opens audio and Codex only for a
frontend-owned call, and disconnect still completes cleanup before another call.

Omitted workspace selection now uses the newest sortable timestamp-and-UUID
name under `$XDG_STATE_HOME/agentvoice/default/workspaces/` (with the ordinary
XDG fallback), initialized atomically when empty. The default frontend endpoint
is stable, while each call pins its selected canonical directory across runtime
replacement; explicit CLI workspaces retain separate sockets, and a file workspace
pins the default server's calls. This replaces the launch-cwd default for server
and frontend without adding workspace deletion, transcript cleanup, named-agent
selection, or a different native context policy.
