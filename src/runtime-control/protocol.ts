/** Private inherited IPC only; no audio, RTP, or capability appears in UI events. */
import type { VoiceTuiState } from "../console/tui.ts";
import type { ControlMcpRegistration } from "../core/control-mcp.ts";
import type { ConsoleOptions, ParsedArgs } from "../main.ts";

export const IPC_VERSION = 1;
export const MAX_IPC_BYTES = 1024 * 1024;
export interface LaunchProvenance {
  parsed: ParsedArgs;
  options: ConsoleOptions;
  launchCwd: string;
}
export interface CandidateInfo {
  workspace: string;
  buildId: string;
  pid: number;
}
export interface RuntimeLaunch {
  provenance: LaunchProvenance;
  version: string;
  control: ControlMcpRegistration;
  workspace?: string;
}
export interface RuntimeActivation {
  threadId?: string;
  mute: { mic: boolean; speaker: boolean };
}
export interface IpcMessage {
  version: typeof IPC_VERSION;
  generation: number;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
}
export function ipcMessage(value: unknown, generation: number): value is IpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as IpcMessage;
  return (
    message.version === IPC_VERSION &&
    message.generation === generation &&
    (message.id === undefined || (Number.isSafeInteger(message.id) && message.id > 0)) &&
    (message.method === undefined || typeof message.method === "string") &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_IPC_BYTES
  );
}
export type RuntimeState = VoiceTuiState;
