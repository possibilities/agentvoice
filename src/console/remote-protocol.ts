import type { TransportPhase } from "./transport.ts";

export const REMOTE_PROTOCOL_VERSION = 2;

export interface RemoteState {
  type: "state";
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  sequence: number;
  phase: TransportPhase;
  mic: { muted: boolean; talking: boolean; level: number };
  speaker: { muted: boolean; level: number };
}

export interface SetMutedCommand {
  type: "set-muted";
  target: "mic" | "speaker";
  muted: boolean;
}

export interface PushToTalkCommand {
  type: "push-to-talk";
  active: boolean;
}

export type RemoteCommand = SetMutedCommand | PushToTalkCommand;

export function encodeRemoteMessage(message: RemoteState | RemoteCommand): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseRemoteCommand(line: string): RemoteCommand | null {
  const value = parseRecord(line);
  if (value?.["type"] === "set-muted") {
    if (
      (value["target"] !== "mic" && value["target"] !== "speaker") ||
      typeof value["muted"] !== "boolean"
    ) {
      return null;
    }
    return { type: "set-muted", target: value["target"], muted: value["muted"] };
  }
  if (value?.["type"] === "push-to-talk" && typeof value["active"] === "boolean") {
    return { type: "push-to-talk", active: value["active"] };
  }
  return null;
}

export function parseRemoteState(line: string): RemoteState | null {
  const value = parseRecord(line);
  if (
    value?.["type"] !== "state" ||
    value["protocol"] !== REMOTE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value["sequence"]) ||
    !isPhase(value["phase"])
  ) {
    return null;
  }
  const mic = parseMicChannel(value["mic"]);
  const speaker = parseChannel(value["speaker"]);
  if (!mic || !speaker) return null;
  return {
    type: "state",
    protocol: REMOTE_PROTOCOL_VERSION,
    sequence: value["sequence"] as number,
    phase: value["phase"],
    mic,
    speaker,
  };
}

function parseMicChannel(
  value: unknown,
): { muted: boolean; talking: boolean; level: number } | null {
  const channel = parseChannel(value);
  if (!channel || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const talking = (value as Record<string, unknown>)["talking"];
  if (typeof talking !== "boolean") return null;
  return { ...channel, talking };
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseChannel(value: unknown): { muted: boolean; level: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const channel = value as Record<string, unknown>;
  if (typeof channel["muted"] !== "boolean" || typeof channel["level"] !== "number") {
    return null;
  }
  if (!Number.isFinite(channel["level"]) || channel["level"] < 0 || channel["level"] > 1) {
    return null;
  }
  return { muted: channel["muted"], level: channel["level"] };
}

function isPhase(value: unknown): value is TransportPhase {
  return (
    value === "waiting-ready" ||
    value === "negotiating" ||
    value === "live" ||
    value === "failed" ||
    value === "stopped"
  );
}
