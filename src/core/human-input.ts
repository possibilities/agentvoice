/** Native human requests belong to attached clients; Codex owns their pending state. */
export function nativeHumanRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
  ].includes(method);
}
