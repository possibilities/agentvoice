# External working roles

AgentStart now owns the former `default` role as `manager`, and the `worker`
role. Their authored prompts and separate MCP inventories live in AgentStart's
`roles/manager` and `roles/worker`. Its normal resource sync assembles launchable
roles at `~/.local/share/agentstart/resources/roles/{manager,worker}`.

```sh
agentvoice server --role ~/.local/share/agentstart/resources/roles/manager
agentvoice server --role ~/.local/share/agentstart/resources/roles/worker
```

AgentVoice consumes convention prompt files, registers the selected skills root,
and passes its MCP definitions to the owned Codex thread. It selects no role
when none is configured. The former source paths here are removed.

Existing workspace role databases retain captured bytes. This ownership change
does not edit snapshots or reload active calls. The mandatory
`agentvoice_control` MCP remains supplied by the call controller.

See [ADR 0051](../docs/adr/0051-agentstart-owns-working-roles.md).
