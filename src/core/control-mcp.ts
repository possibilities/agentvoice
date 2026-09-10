/** Request-scoped mandatory control registration and native catalog readiness. */
import { ConfigError } from "./config.ts";

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
  // Stock 0.153.4 snapshots a separate MCP connection set, including other servers
  // with a 30s default startup timeout. Keep one budget across polling and pages,
  // inside the controller's 90s activation deadline.
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    type Status = {
      name?: string;
      runtimeStatus?: string | null;
      authStatus?: string;
      tools?: Record<string, unknown>;
    };
    const matching: Status[] = [];
    let entries = 0;
    for (let page = 0; page < 16; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("AgentVoice control MCP readiness timed out");
      const result = await request<{ data?: Status[]; nextCursor?: string | null }>(
        "mcpServerStatus/list",
        { threadId, detail: "toolsAndAuthOnly", limit: 64, ...(cursor ? { cursor } : {}) },
        remaining,
      );
      if (!Array.isArray(result.data)) throw new Error("Control MCP returned a malformed catalog");
      entries += result.data.length;
      if (entries > 1024) throw new Error("Control MCP catalog exceeded its entry limit");
      matching.push(...result.data.filter((entry) => entry.name === registration.name));
      if (!result.nextCursor) break;
      if (seen.has(result.nextCursor))
        throw new Error("Control MCP status pagination repeated a cursor");
      if (page === 15) throw new Error("Control MCP catalog exceeded its page limit");
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    if (matching.length > 1)
      throw new Error("Control MCP catalog has duplicate reserved server entries");
    const status = matching[0];
    if (status && status.runtimeStatus !== "starting" && status.runtimeStatus !== "notStarted") {
      const tools = status.tools;
      if (
        status.runtimeStatus !== "connected" ||
        status.authStatus !== "bearerToken" ||
        !record(tools) ||
        Object.keys(tools).length !== registration.tools.length ||
        registration.tools.some((name) => !Object.hasOwn(tools, name))
      )
        throw new Error(
          "AgentVoice control MCP connected without authenticated readiness and its required tool catalog",
        );
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new Error("AgentVoice control MCP is not ready; runtime startup can be retried");
}
