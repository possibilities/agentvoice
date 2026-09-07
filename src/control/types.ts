/**
 * Controller-owned facts exposed by the local control plane.  The transport
 * deliberately has no runtime or thread ownership.
 */
export const CONTROL_PROTOCOL_VERSION = 3;
export const CONTROL_MCP_SERVER_NAME = "agentvoice_control";
export const CONTROL_MCP_PATH = "/mcp";
export const CONTROL_SOCKET_ENV = "AGENTVOICE_CONTROL_SOCKET";
export const CONTROL_MCP_TOOLS = ["agentvoice_status"] as const;

export type ControlStatus = {
  protocolVersion: number;
  instanceId: string;
  workspace: string;
  threadId: string;
  generation: number;
  runtime: { pid?: number; buildId?: string; phase: string; voicePhase?: string };
};

type MaybePromise<T> = T | Promise<T>;

/** The controller implements this; control transports only validate and dispatch. */
export interface ControlBackend {
  status(): MaybePromise<ControlStatus>;
}

/** A stable error suitable for both JSON socket and MCP error results. */
export class ControlError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_params"
      | "unknown_method"
      | "instance_mismatch"
      | "stale_generation"
      | "unavailable"
      | "internal_error",
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export type ControlMcpServerConfig = {
  url: string;
  bearer_token_env_var: string;
  startup_timeout_sec: 5;
  tool_timeout_sec: 5;
  required: true;
  enabled_tools: readonly string[];
};

export type ControlServer = {
  socketPath: string;
  socketEnvVar: typeof CONTROL_SOCKET_ENV;
  httpUrl: string;
  /** Put this value in bearerTokenEnvVar only in the owned Codex child's env. */
  bearerToken: string;
  bearerTokenEnvVar: string;
  mcpServer: ControlMcpServerConfig;
  close(): Promise<void>;
};
