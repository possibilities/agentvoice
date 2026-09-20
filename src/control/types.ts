import type { DirectoryRoleStatus, WorkspaceRoleSourceStatus } from "../core/role-content.ts";
import type { VoiceInspection } from "../core/voice-inspection.ts";
import type { RoleRef, VoiceEdit } from "../roles/store.ts";
/**
 * Controller-owned facts exposed by the local control plane.  The transport
 * deliberately has no runtime, thread, or operation-journal ownership.
 */
export const CONTROL_PROTOCOL_VERSION = 9;
export const CONTROL_MCP_SERVER_NAME = "agentvoice_control";
export const CONTROL_MCP_PATH = "/mcp";
export const CONTROL_SOCKET_ENV = "AGENTVOICE_CONTROL_SOCKET";
export const CONTROL_MCP_TOOLS = [
  "agentvoice_status",
  "agentvoice_redial",
  "agentvoice_restart_runtime",
  "agentvoice_new_session",
  "agentvoice_voice_set",
  "agentvoice_voice_get",
] as const;

export type ControlOperationPhase =
  | "accepted"
  | "quiescing"
  | "interrupted"
  | "forced"
  | "starting"
  | "ready"
  | "failed";

export type ControlMutationRequest = {
  operationId: string;
  expectedGeneration: number;
  expectedInstanceId: string;
};

export type ControlRestartRequest = ControlMutationRequest & {
  scope: "runtime";
  handoffPrompt?: string;
};

export type ControlHandoff = {
  status: "pending" | "submitting" | "accepted" | "failed" | "unknown";
  clientUserMessageId: string;
  turnId?: string;
  error?: { code: string; message: string };
};

export type ControlOperation = {
  voiceEdit?: VoiceEdit & {
    saved: RoleRef;
    application: "pending" | "applied" | "deferred" | "failed" | "unknown";
  };
  operationId: string;
  kind: "redial" | "restart" | "new-session" | "voice-set";
  scope: "voice" | "runtime";
  expectedGeneration: number;
  expectedInstanceId: string;
  phase: ControlOperationPhase;
  acceptedAt: string;
  updatedAt: string;
  forced?: boolean;
  result?: {
    generation: number;
    threadId: string;
    workspace: string;
    pid?: number;
    buildId?: string;
  };
  error?: { code: string; message: string };
  handoff?: ControlHandoff;
};

export type ControlStatus = {
  directoryRole?: DirectoryRoleStatus;
  role?: {
    adoptionSource?: WorkspaceRoleSourceStatus;
    loaded: RoleRef;
    desired?: RoleRef;
    desiredVoice?: string | null;
    voiceRevision: number;
    voice: string | null;
    error?: string;
  };
  protocolVersion: number;
  instanceId: string;
  workspace: string;
  threadId: string;
  generation: number;
  runtime: {
    pid?: number;
    buildId?: string;
    phase: string;
    voicePhase?: string;
    attachmentReady?: boolean;
  };
  currentOperation?: ControlOperation;
  recentOperations: ControlOperation[];
};

export type VoiceSetRequest = Omit<VoiceEdit, "voice" | "catalog" | "selection"> &
  (
    | { voice: string | null; selection?: never }
    | { selection: { kind: "random"; excludeCurrent: true }; voice?: never }
  );
export type VoiceGetResult = {
  instanceId: string;
  generation: number;
  workspace: string;
  threadId: string;
  nativePid?: number;
  phase: string;
  editable: boolean;
  canApplyNow: boolean;
  editError?: string;
  inspection: VoiceInspection;
  role?: NonNullable<ControlStatus["role"]>;
};

type MaybePromise<T> = T | Promise<T>;

/** The controller implements this; control transports only validate and dispatch. */
export interface ControlBackend {
  voiceGet(request: { refresh?: boolean }): Promise<VoiceGetResult>;
  voiceSet(request: VoiceSetRequest): Promise<ControlOperation>;
  status(): MaybePromise<ControlStatus>;
  redial(request: ControlMutationRequest): Promise<ControlOperation>;
  restart(request: ControlRestartRequest): Promise<ControlOperation>;
  newSession(request: ControlMutationRequest): Promise<ControlOperation>;
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
      | "operation_conflict"
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
