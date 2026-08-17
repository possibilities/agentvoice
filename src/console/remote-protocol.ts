import type { TransportPhase } from "./transport.ts";

export const REMOTE_PROTOCOL_VERSION = 4;

export type RemoteAudioTarget = "mic" | "speaker";
export type RemoteUnmuteInput = "pointer" | "key" | "space";

export interface RemoteChannelState {
  /** The persistent mute assignment. */
  muted: boolean;
  /** The assignment currently applied after active unmute holds. */
  effectiveMuted: boolean;
  level: number;
}

export interface RemoteState {
  type: "state";
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  sequence: number;
  phase: TransportPhase;
  mic: RemoteChannelState;
  speaker: RemoteChannelState;
}

export interface SetMutedCommand {
  type: "set-muted";
  target: RemoteAudioTarget;
  muted: boolean;
}

export interface HoldUnmutedCommand {
  type: "hold-unmuted";
  target: RemoteAudioTarget;
  input: RemoteUnmuteInput;
}

export interface ReleaseUnmutedCommand {
  type: "release-unmuted";
  target: RemoteAudioTarget;
  input: RemoteUnmuteInput;
  commit: boolean;
}

export type RemoteCommand = SetMutedCommand | HoldUnmutedCommand | ReleaseUnmutedCommand;

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
  if (value?.["type"] === "hold-unmuted") {
    if (!isAudioTarget(value["target"]) || !isHoldInput(value["input"])) {
      return null;
    }
    return {
      type: "hold-unmuted",
      target: value["target"],
      input: value["input"],
    };
  }
  if (value?.["type"] === "release-unmuted") {
    if (
      !isAudioTarget(value["target"]) ||
      !isHoldInput(value["input"]) ||
      typeof value["commit"] !== "boolean"
    ) {
      return null;
    }
    return {
      type: "release-unmuted",
      target: value["target"],
      input: value["input"],
      commit: value["commit"],
    };
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
  const mic = parseChannel(value["mic"]);
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

function parseChannel(value: unknown): RemoteChannelState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const channel = value as Record<string, unknown>;
  if (
    typeof channel["muted"] !== "boolean" ||
    typeof channel["effectiveMuted"] !== "boolean" ||
    typeof channel["level"] !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(channel["level"]) || channel["level"] < 0 || channel["level"] > 1) {
    return null;
  }
  return {
    muted: channel["muted"],
    effectiveMuted: channel["effectiveMuted"],
    level: channel["level"],
  };
}

function isAudioTarget(value: unknown): value is RemoteAudioTarget {
  return value === "mic" || value === "speaker";
}

function isHoldInput(value: unknown): value is RemoteUnmuteInput {
  return value === "pointer" || value === "key" || value === "space";
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
