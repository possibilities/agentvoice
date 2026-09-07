# Using AgentVoice from an orchestrator

Run `agentvoice server` in the workspace and `agentvoice` in another terminal.
The frontend starts a call. Closing its terminal or terminating its process ends
the call and its native work; the server then waits for another frontend.

The working thread receives the required `agentvoice_control` MCP entry with
one read-only tool: `agentvoice_status({})`. It reports the exact call instance,
workspace/thread, runtime generation and connection phase. No mutation,
redial, runtime restart, Fresh or restart handoff is exposed.

For another local MCP client, run:

```sh
agentvoice mcp-config --workspace /absolute/workspace
claude --mcp-config <(agentvoice mcp-config --workspace /absolute/workspace)
```

The export contains the active call's private bearer capability. Keep it private
and regenerate it for each call. This command only discovers an active controller;
it never launches Codex or audio. Native Codex configuration has a different shape.

Use `agentvoice attach` for native typed interaction, approvals and tool questions.
The stock TUI retains its native commands; the minimal voice frontend has none.
Use the [event socket](docs/events.md) for conversation observation, and the
[control API](docs/api.md) for exact schemas and transport bounds.
