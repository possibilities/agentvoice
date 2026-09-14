# 0056: Transfer durable Work and HUD into independent AgentHUD

Accepted 2026-09-14 by explicit human request. Supersedes [0055](0055-durable-work-hud.md)
for source colocation, packaging and the initial no-resident-service delivery.
The human wants HUD organized and always available like other fleet projects.

AgentHUD owns `~/code/agenthud`: CLI/MCP, Work schema/store, web UI, installer,
skill, tests and decisions. Remove the corresponding AgentVoice source and package
entries; no redirect, duplicate implementation or cross-repository source import
remains. The existing command, independent state path and database schema stay
unchanged. Its installer explicitly validates receipt-correlated legacy source
before moving the editable command link; it never imports or mutates Board data.

AgentVoice retains native observation and exports `agentvoice threads --json` as
version 1 `{schemaVersion, observedAt, monitor}`. Fields are whitelisted metadata,
not arbitrary RPC output, credentials or socket descriptors. The exact instance,
generation, root, thread and turn identities and incomplete/unavailable inventory
remain visible. The independent consumer bounds and validates this command's
output. Native execution, discovery and compatibility remain AgentVoice-owned.
This command invokes no inference, audio, restart or credential operation.

AgentStart owns the separate `io.arthack.agenthud.serve` LaunchAgent invoking the
installed AgentHUD CLI through the existing Portless proxy. Default editable Vite
with HMR and optional prepared production serving follow the fleet UI pattern.
Source installation prepares dependencies/assets; runtime startup never installs.
Targeted HUD service convergence never restarts AgentVoice, AgentChats or the proxy.

AgentHUD preserves transactional Work/Assignment/Result semantics, idempotency,
revision fences and distinct return/acceptance/presentation facts from 0055.
Native observer tests remain here; durable owner/UI tests move with their owner.
