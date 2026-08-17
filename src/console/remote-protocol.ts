import type { TransportPhase } from "./transport.ts";

export const REMOTE_PROTOCOL_VERSION = 7;

export type RemoteAudioTarget = "mic" | "speaker";
export type RemoteUnmuteInput = "pointer" | "key" | "space";

export interface RemoteChannelState {
  /** The persistent mute assignment. */
  muted: boolean;
  /** The assignment currently applied after active unmute holds. */
  effectiveMuted: boolean;
  /** RMS in dBFS; null represents digital silence. */
  db: number | null;
}

export interface RemoteState {
  type: "state";
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  sequence: number;
  phase: TransportPhase;
  liveForMs: number | null;
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

export interface RedialCommand {
  type: "redial";
}

export interface FreshCommand {
  type: "fresh";
}

/**
 * First frame on a network attachment. `protocol` is carried as a plain number
 * rather than the pinned literal so a mismatched Remote console is told what
 * happened instead of being dropped without a word.
 */
export interface HelloCommand {
  type: "hello";
  protocol: number;
  token: string;
}

/**
 * Liveness beat. A network peer that stops beating has its unmute holds
 * released — a TCP close can lag a dead Remote console by minutes, and a
 * stranded hold leaves the microphone open.
 */
export interface PingCommand {
  type: "ping";
}

export type RemoteCommand =
  | SetMutedCommand
  | HoldUnmutedCommand
  | ReleaseUnmutedCommand
  | RedialCommand
  | FreshCommand
  | HelloCommand
  | PingCommand;

/** Refusal of a network attachment; the Remote console surfaces it and exits. */
export interface RemoteReject {
  type: "reject";
  reason: string;
}

export type RemoteMessage = RemoteState | RemoteReject;

export function encodeRemoteMessage(message: RemoteMessage | RemoteCommand): string {
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
  if (value?.["type"] === "hello") {
    if (!Number.isSafeInteger(value["protocol"]) || typeof value["token"] !== "string") {
      return null;
    }
    return { type: "hello", protocol: value["protocol"] as number, token: value["token"] };
  }
  if (value?.["type"] === "ping") return { type: "ping" };
  if (value?.["type"] === "redial") return { type: "redial" };
  if (value?.["type"] === "fresh") return { type: "fresh" };
  return null;
}

export function parseRemoteReject(line: string): RemoteReject | null {
  const value = parseRecord(line);
  if (value?.["type"] !== "reject" || typeof value["reason"] !== "string") return null;
  return { type: "reject", reason: value["reason"] };
}

export function parseRemoteState(line: string): RemoteState | null {
  const value = parseRecord(line);
  if (
    value?.["type"] !== "state" ||
    value["protocol"] !== REMOTE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value["sequence"]) ||
    !isPhase(value["phase"]) ||
    !isLiveDuration(value["liveForMs"])
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
    liveForMs: value["liveForMs"] as number | null,
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
    !isDb(channel["db"])
  ) {
    return null;
  }
  return {
    muted: channel["muted"],
    effectiveMuted: channel["effectiveMuted"],
    db: channel["db"] as number | null,
  };
}

function isDb(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value <= 0);
}

function isLiveDuration(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
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
