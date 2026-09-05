import { createHash } from "node:crypto";
import { publishControlDescriptor } from "./discovery.ts";
import { ControlMcpHttpHost } from "./mcp.ts";
import { ControlSocketServer, controlSocketPath } from "./socket.ts";
import {
  CONTROL_MCP_SERVER_NAME,
  CONTROL_MCP_TOOLS,
  CONTROL_SOCKET_ENV,
  type ControlBackend,
  type ControlServer,
} from "./types.ts";

export * from "./contract.ts";
export * from "./types.ts";

export type StartControlServerOptions = {
  backend: ControlBackend;
  stateDir: string;
  instanceId: string;
};

/** Start the controller-owned transports before any runtime is launched. */
export async function startControlServer(
  options: StartControlServerOptions,
): Promise<ControlServer> {
  const socketPath = controlSocketPath(options.stateDir, options.instanceId);
  const socket = new ControlSocketServer(socketPath, options.backend);
  const http = new ControlMcpHttpHost(options.backend);
  try {
    await socket.start();
    const httpUrl = http.start();
    const suffix = createHash("sha256")
      .update(options.instanceId)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();
    const bearerTokenEnvVar = `AGENTVOICE_CONTROL_BEARER_${suffix}`;
    const removeDescriptor = publishControlDescriptor(options.stateDir, {
      version: 1,
      instanceId: options.instanceId,
      controllerPid: process.pid,
      socketPath,
      url: httpUrl,
      token: http.token,
    });
    return {
      socketPath,
      socketEnvVar: CONTROL_SOCKET_ENV,
      httpUrl,
      bearerToken: http.token,
      bearerTokenEnvVar,
      mcpServer: {
        url: httpUrl,
        bearer_token_env_var: bearerTokenEnvVar,
        startup_timeout_sec: 5,
        tool_timeout_sec: 5,
        required: true,
        enabled_tools: CONTROL_MCP_TOOLS,
      },
      close: async () => {
        try {
          removeDescriptor();
        } finally {
          await http.close();
          socket.close();
        }
      },
    };
  } catch (error) {
    await http.close();
    socket.close();
    throw error;
  }
}

export { CONTROL_MCP_SERVER_NAME };
