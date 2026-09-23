# External working roles

AgentStart owns one working role named `default`. Its authored prompts and MCP
inventory live in AgentStart's `roles/default`. Normal resource sync assembles it
at `~/.local/share/agentstart/resources/roles/default` and retires intact owned
`manager` and `worker` outputs without aliases.

```sh
agentvoice server --role ~/.local/share/agentstart/resources/roles/default
```

AgentVoice consumes convention prompt files, registers the selected skills root,
and passes its MCP definitions to the owned Codex thread. It selects no role
when none is configured. The former source paths here are removed.

Existing workspace role databases retain captured bytes. This ownership change
does not edit snapshots or reload active calls. The mandatory
`agentvoice_control` MCP remains supplied by the call controller.

See [ADR 0108](../docs/adr/0108-use-one-agentstart-default-role.md).
