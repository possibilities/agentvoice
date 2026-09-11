/** Request-scoped mandatory control registration and authenticated native readiness. */
import { ConfigError } from "./config.ts";

const CONTROL_READINESS_TOOL = "agentvoice_status";

export interface ControlMcpRegistration {
  name: string;
  server: Record<string, unknown>;
  tools: readonly string[];
  env: Record<string, string>;
}

export function injectControlMcp(
  params: Record<string, unknown>,
  registration: ControlMcpRegistration,
): Record<string, unknown> {
  const config = params["config"];
  if (config !== undefined && !record(config))
    throw new ConfigError("Mandatory control MCP requires an object thread config");
  const servers = record(config) ? config["mcp_servers"] : undefined;
  if (servers !== undefined && !record(servers))
    throw new ConfigError("Mandatory control MCP requires an object mcp_servers map");
  if (record(servers) && Object.hasOwn(servers, registration.name))
    throw new ConfigError(
      `MCP server name "${registration.name}" is reserved for AgentVoice control`,
    );
  return {
    ...params,
    config: {
      ...(config ?? {}),
      mcp_servers: { ...(servers ?? {}), [registration.name]: registration.server },
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function requireControlMcpReady(
  request: <T = unknown>(method: string, params: unknown, timeout?: number) => Promise<T>,
  threadId: string,
  registration: ControlMcpRegistration,
  timeoutMs = 10_000,
): Promise<void> {
  if (!registration.tools.includes(CONTROL_READINESS_TOOL))
    throw new Error("AgentVoice control MCP has no readiness tool");

  // A thread-scoped direct call uses the published MCP connection. Success proves
  // that native Codex authenticated to this call's unique loopback server and
  // discovered its statically registered, enabled tool set. mcpServerStatus/list
  // rebuilds the global MCP inventory and waits for unrelated servers.
  const result = await request<{
    isError?: boolean;
    structuredContent?: unknown;
  }>(
    "mcpServer/tool/call",
    {
      threadId,
      server: registration.name,
      tool: CONTROL_READINESS_TOOL,
      arguments: {},
    },
    timeoutMs,
  );
  const status = result?.structuredContent;
  if (
    result?.isError === true ||
    !record(status) ||
    !Number.isSafeInteger(status["protocolVersion"]) ||
    typeof status["instanceId"] !== "string" ||
    status["instanceId"].length === 0 ||
    !record(status["runtime"]) ||
    !Array.isArray(status["recentOperations"])
  )
    throw new Error("AgentVoice control MCP returned an invalid authenticated readiness result");
}
