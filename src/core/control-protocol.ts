/**
 * The control attachment's wire protocol: line-delimited JSON between the
 * Server and its peers over the owner-only unix socket or the tailnet
 * WebSocket. Two peer roles share the one protocol — ui peers (Remote
 * consoles) mirror state and send commands; the single voice peer (the
 * Console that owns the duplex audio device and the WebRTC media session)
 * additionally carries the voice-session signaling that used to be an
 * in-process interface: session events down, SDP offers and instrument
 * state up. Mute authority stays with the voice peer; the Server only
 * routes and fans out.
 */

import { containsAsciiControl } from "./safe-text.ts";

export const CONTROL_PROTOCOL_VERSION = 9;

export type ControlRole = "ui" | "voice";
export type ControlAudioTarget = "mic" | "speaker";
export type ControlUnmuteInput = "pointer" | "key" | "space";

/** The voice transport's lifecycle phase, owned by the voice peer. */
export type VoicePhase = "waiting-ready" | "negotiating" | "live" | "failed" | "stopped";

export interface ControlChannelState {
  /** The persistent mute assignment. */
  muted: boolean;
  /** The assignment currently applied after active unmute holds. */
  effectiveMuted: boolean;
  /** RMS in dBFS; null represents digital silence. */
  db: number | null;
}

/** The voice peer's published instrument state; absent when none is attached. */
export interface VoiceStateBody {
  phase: VoicePhase;
  liveForMs: number | null;
  mic: ControlChannelState;
  speaker: ControlChannelState;
}

/** What `thread/start` resolved to; mirrored to the voice peer on attach. */
export interface SessionReadyInfo {
  threadId: string;
  workspace: string;
  /** null means "codex default". */
  model: string | null;
  effort: string | null;
  voiceModel: string | null;
  voice: string | null;
  /** Prompt files priming the agents. */
  prompts: string[];
}

// ---------------------------------------------------------------------------
// Peer → Server
// ---------------------------------------------------------------------------

/**
 * First frame on every attachment, unix and network alike: it declares the
 * peer's role. `protocol` is carried as a plain number rather than the pinned
 * literal so a mismatched peer is told what happened instead of being dropped
 * without a word. `token` admits network peers; the unix socket's boundary is
 * filesystem permissions.
 */
export interface HelloCommand {
  type: "hello";
  protocol: number;
  role: ControlRole;
  token?: string;
  device?: {
    id: string;
    signature: string;
  };
  /**
   * A nonce the Server must sign with its identity key (`auth-proof`) before
   * the device trusts the link — the Server's half of mutual authentication,
   * for runtimes whose TLS stack cannot pin the identity certificate.
   */
  serverChallenge?: string;
}

/** Starts the deliberately opened, human-verified pairing flow from a network peer. */
export interface PairBeginCommand {
  type: "pair-begin";
  protocol: number;
  deviceId: string;
  deviceName: string;
  publicKey: string;
  clientNonce: string;
}

export interface PairDeviceConfirmCommand {
  type: "pair-device-confirm";
  sessionId: string;
  signature: string;
}

/** Local-owner commands: network peers can never open or approve pairing. */
export interface PairingOpenCommand {
  type: "pairing-open";
}

export interface PairingLocalConfirmCommand {
  type: "pairing-local-confirm";
  sessionId: string;
}

export interface PairingCancelCommand {
  type: "pairing-cancel";
}

/**
 * Liveness beat. A network peer that stops beating has its unmute holds
 * released — a TCP close can lag a dead peer by minutes, and a stranded hold
 * leaves the microphone open.
 */
export interface PingCommand {
  type: "ping";
}

export interface SetMutedCommand {
  type: "set-muted";
  target: ControlAudioTarget;
  muted: boolean;
}

export interface HoldUnmutedCommand {
  type: "hold-unmuted";
  target: ControlAudioTarget;
  input: ControlUnmuteInput;
}

export interface ReleaseUnmutedCommand {
  type: "release-unmuted";
  target: ControlAudioTarget;
  input: ControlUnmuteInput;
  commit: boolean;
}

export interface RedialCommand {
  type: "redial";
}

export interface FreshCommand {
  type: "fresh";
}

/** Voice peer only: an SDP offer for a new voice session. */
export interface OfferCommand {
  type: "offer";
  sdp: string;
}

/** Voice peer only: the instrument state the Server fans out to ui peers. */
export interface VoiceStateCommand {
  type: "voice-state";
  voice: VoiceStateBody;
}

export type ControlCommand =
  | HelloCommand
  | PairBeginCommand
  | PairDeviceConfirmCommand
  | PairingOpenCommand
  | PairingLocalConfirmCommand
  | PairingCancelCommand
  | PingCommand
  | SetMutedCommand
  | HoldUnmutedCommand
  | ReleaseUnmutedCommand
  | RedialCommand
  | FreshCommand
  | OfferCommand
  | VoiceStateCommand;

// ---------------------------------------------------------------------------
// Server → peer
// ---------------------------------------------------------------------------

/** The Server's signature over the hello's serverChallenge. */
export interface AuthProofFrame {
  type: "auth-proof";
  signature: string;
}

/** Fresh per-connection material a paired device signs before its hello is admitted. */
export interface AuthChallengeFrame {
  type: "auth-challenge";
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  challenge: string;
}

export interface PairChallengeFrame {
  type: "pair-challenge";
  sessionId: string;
  serverId: string;
  serverName: string;
  certificate: string;
  deviceId: string;
  clientNonce: string;
  serverNonce: string;
  endpoints: string[];
  port: number;
}

export type PairingStatus = "open" | "awaiting-confirmation" | "complete" | "failed" | "cancelled";

export interface PairingStateFrame {
  type: "pairing-state";
  status: PairingStatus;
  expiresAt?: number;
  sessionId?: string;
  code?: string;
  deviceName?: string;
  message?: string;
}

export interface PairCompleteFrame {
  type: "pair-complete";
  serverId: string;
  serverName: string;
  certificate: string;
  deviceId: string;
  endpoints: string[];
  port: number;
}

/** `voice: null` means no voice peer is attached — nothing to hear or mute. */
export interface ControlState {
  type: "state";
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  sequence: number;
  voice: VoiceStateBody | null;
}

/** Refusal of an attachment; the peer surfaces it and exits. */
export interface RejectFrame {
  type: "reject";
  reason: string;
}

export interface SessionReadyFrame {
  type: "session-ready";
  info: SessionReadyInfo;
}

export interface SessionAnswerFrame {
  type: "session-answer";
  sdp: string;
}

export interface SessionClosedFrame {
  type: "session-closed";
  reason?: string;
}

export interface SessionRedialFrame {
  type: "session-redial";
  reason: string;
}

export interface SessionErrorFrame {
  type: "session-error";
  message: string;
  fatal: boolean;
}

/** Another voice peer took over; stand down to a ui peer. */
export interface VoiceSupersededFrame {
  type: "voice-superseded";
}

/** A ui peer's command routed to the voice peer, which owns the gates. */
export interface RouteSetMutedFrame {
  type: "route-set-muted";
  target: ControlAudioTarget;
  muted: boolean;
}

/** `source` is Server-assigned per (peer, input) so releases stay scoped. */
export interface RouteHoldFrame {
  type: "route-hold";
  target: ControlAudioTarget;
  source: string;
}

export interface RouteReleaseFrame {
  type: "route-release";
  target: ControlAudioTarget;
  source: string;
  commit: boolean;
}

export interface RouteRedialFrame {
  type: "route-redial";
}

export type ServerFrame =
  | AuthProofFrame
  | AuthChallengeFrame
  | PairChallengeFrame
  | PairingStateFrame
  | PairCompleteFrame
  | ControlState
  | RejectFrame
  | SessionReadyFrame
  | SessionAnswerFrame
  | SessionClosedFrame
  | SessionRedialFrame
  | SessionErrorFrame
  | VoiceSupersededFrame
  | RouteSetMutedFrame
  | RouteHoldFrame
  | RouteReleaseFrame
  | RouteRedialFrame;

export function encodeControlFrame(frame: ControlCommand | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

// ---------------------------------------------------------------------------
// Parsing (Server side)
// ---------------------------------------------------------------------------

export function parseControlCommand(line: string): ControlCommand | null {
  const value = parseRecord(line);
  if (value === null) return null;
  switch (value["type"]) {
    case "hello": {
      const device = parseDeviceProof(value["device"]);
      const serverChallenge = value["serverChallenge"];
      if (
        !Number.isSafeInteger(value["protocol"]) ||
        !isRole(value["role"]) ||
        (value["token"] !== undefined && typeof value["token"] !== "string") ||
        (value["device"] !== undefined && device === null) ||
        (serverChallenge !== undefined && !isChallenge(serverChallenge))
      ) {
        return null;
      }
      return {
        type: "hello",
        protocol: value["protocol"] as number,
        role: value["role"],
        ...(typeof value["token"] === "string" ? { token: value["token"] } : {}),
        ...(device ? { device } : {}),
        ...(isChallenge(serverChallenge) ? { serverChallenge } : {}),
      };
    }
    case "pair-begin": {
      if (
        !Number.isSafeInteger(value["protocol"]) ||
        !isBoundedString(value["deviceId"], 128) ||
        !isBoundedString(value["deviceName"], 96) ||
        !isBoundedString(value["publicKey"], 1024) ||
        !isBoundedString(value["clientNonce"], 256)
      ) {
        return null;
      }
      return {
        type: "pair-begin",
        protocol: value["protocol"] as number,
        deviceId: value["deviceId"],
        deviceName: value["deviceName"],
        publicKey: value["publicKey"],
        clientNonce: value["clientNonce"],
      };
    }
    case "pair-device-confirm": {
      if (!isBoundedString(value["sessionId"], 128) || !isBoundedString(value["signature"], 512))
        return null;
      return {
        type: "pair-device-confirm",
        sessionId: value["sessionId"],
        signature: value["signature"],
      };
    }
    case "pairing-open":
      return { type: "pairing-open" };
    case "pairing-local-confirm": {
      if (!isBoundedString(value["sessionId"], 128)) return null;
      return { type: "pairing-local-confirm", sessionId: value["sessionId"] };
    }
    case "pairing-cancel":
      return { type: "pairing-cancel" };
    case "ping":
      return { type: "ping" };
    case "set-muted": {
      if (!isAudioTarget(value["target"]) || typeof value["muted"] !== "boolean") return null;
      return { type: "set-muted", target: value["target"], muted: value["muted"] };
    }
    case "hold-unmuted": {
      if (!isAudioTarget(value["target"]) || !isHoldInput(value["input"])) return null;
      return { type: "hold-unmuted", target: value["target"], input: value["input"] };
    }
    case "release-unmuted": {
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
    case "redial":
      return { type: "redial" };
    case "fresh":
      return { type: "fresh" };
    case "offer": {
      if (typeof value["sdp"] !== "string" || value["sdp"] === "") return null;
      return { type: "offer", sdp: value["sdp"] };
    }
    case "voice-state": {
      const voice = parseVoiceBody(value["voice"]);
      if (!voice) return null;
      return { type: "voice-state", voice };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing (peer side)
// ---------------------------------------------------------------------------

export function parseServerFrame(line: string): ServerFrame | null {
  const value = parseRecord(line);
  if (value === null) return null;
  switch (value["type"]) {
    case "auth-proof": {
      if (!isBoundedString(value["signature"], 512)) return null;
      return { type: "auth-proof", signature: value["signature"] as string };
    }
    case "auth-challenge": {
      if (
        value["protocol"] !== CONTROL_PROTOCOL_VERSION ||
        !isBoundedString(value["challenge"], 256)
      )
        return null;
      return {
        type: "auth-challenge",
        protocol: CONTROL_PROTOCOL_VERSION,
        challenge: value["challenge"],
      };
    }
    case "pair-challenge": {
      const profile = parsePairProfile(value);
      if (
        !profile ||
        !isBoundedString(value["sessionId"], 128) ||
        !isBoundedString(value["clientNonce"], 256) ||
        !isBoundedString(value["serverNonce"], 256)
      ) {
        return null;
      }
      return {
        type: "pair-challenge",
        sessionId: value["sessionId"],
        ...profile,
        clientNonce: value["clientNonce"],
        serverNonce: value["serverNonce"],
      };
    }
    case "pairing-state": {
      if (!isPairingStatus(value["status"])) return null;
      if (value["expiresAt"] !== undefined && !Number.isSafeInteger(value["expiresAt"]))
        return null;
      for (const key of ["sessionId", "code", "deviceName", "message"] as const) {
        if (value[key] !== undefined && !isBoundedString(value[key], key === "message" ? 512 : 128))
          return null;
      }
      return {
        type: "pairing-state",
        status: value["status"],
        ...(typeof value["expiresAt"] === "number" ? { expiresAt: value["expiresAt"] } : {}),
        ...(typeof value["sessionId"] === "string" ? { sessionId: value["sessionId"] } : {}),
        ...(typeof value["code"] === "string" ? { code: value["code"] } : {}),
        ...(typeof value["deviceName"] === "string" ? { deviceName: value["deviceName"] } : {}),
        ...(typeof value["message"] === "string" ? { message: value["message"] } : {}),
      };
    }
    case "pair-complete": {
      const profile = parsePairProfile(value);
      return profile ? { type: "pair-complete", ...profile } : null;
    }
    case "state": {
      if (
        value["protocol"] !== CONTROL_PROTOCOL_VERSION ||
        !Number.isSafeInteger(value["sequence"])
      ) {
        return null;
      }
      const voice = value["voice"] === null ? null : parseVoiceBody(value["voice"]);
      if (voice === undefined || (voice === null && value["voice"] !== null)) return null;
      return {
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: value["sequence"] as number,
        voice,
      };
    }
    case "reject": {
      if (typeof value["reason"] !== "string") return null;
      return { type: "reject", reason: value["reason"] };
    }
    case "session-ready": {
      const info = parseReadyInfo(value["info"]);
      if (!info) return null;
      return { type: "session-ready", info };
    }
    case "session-answer": {
      if (typeof value["sdp"] !== "string" || value["sdp"] === "") return null;
      return { type: "session-answer", sdp: value["sdp"] };
    }
    case "session-closed": {
      if (value["reason"] !== undefined && typeof value["reason"] !== "string") return null;
      return {
        type: "session-closed",
        ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
      };
    }
    case "session-redial": {
      if (typeof value["reason"] !== "string") return null;
      return { type: "session-redial", reason: value["reason"] };
    }
    case "session-error": {
      if (typeof value["message"] !== "string" || typeof value["fatal"] !== "boolean") return null;
      return { type: "session-error", message: value["message"], fatal: value["fatal"] };
    }
    case "voice-superseded":
      return { type: "voice-superseded" };
    case "route-set-muted": {
      if (!isAudioTarget(value["target"]) || typeof value["muted"] !== "boolean") return null;
      return { type: "route-set-muted", target: value["target"], muted: value["muted"] };
    }
    case "route-hold": {
      if (!isAudioTarget(value["target"]) || typeof value["source"] !== "string") return null;
      return { type: "route-hold", target: value["target"], source: value["source"] };
    }
    case "route-release": {
      if (
        !isAudioTarget(value["target"]) ||
        typeof value["source"] !== "string" ||
        typeof value["commit"] !== "boolean"
      ) {
        return null;
      }
      return {
        type: "route-release",
        target: value["target"],
        source: value["source"],
        commit: value["commit"],
      };
    }
    case "route-redial":
      return { type: "route-redial" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

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

function parseDeviceProof(value: unknown): { id: string; signature: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proof = value as Record<string, unknown>;
  if (!isBoundedString(proof["id"], 128) || !isBoundedString(proof["signature"], 512)) return null;
  return { id: proof["id"], signature: proof["signature"] };
}

function parsePairProfile(value: Record<string, unknown>): Omit<PairCompleteFrame, "type"> | null {
  if (
    !isBoundedString(value["serverId"], 128) ||
    !isBoundedString(value["serverName"], 253) ||
    !isBoundedString(value["certificate"], 64 * 1024) ||
    !isBoundedString(value["deviceId"], 128) ||
    !Array.isArray(value["endpoints"]) ||
    value["endpoints"].length > 16 ||
    !value["endpoints"].every((endpoint) => isBoundedString(endpoint, 253)) ||
    !Number.isSafeInteger(value["port"]) ||
    (value["port"] as number) < 1 ||
    (value["port"] as number) > 65535
  ) {
    return null;
  }
  return {
    serverId: value["serverId"],
    serverName: value["serverName"],
    certificate: value["certificate"],
    deviceId: value["deviceId"],
    endpoints: value["endpoints"] as string[],
    port: value["port"] as number,
  };
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !containsAsciiControl(value, true)
  );
}

function isPairingStatus(value: unknown): value is PairingStatus {
  return (
    value === "open" ||
    value === "awaiting-confirmation" ||
    value === "complete" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function parseVoiceBody(value: unknown): VoiceStateBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!isPhase(body["phase"]) || !isLiveDuration(body["liveForMs"])) return null;
  const mic = parseChannel(body["mic"]);
  const speaker = parseChannel(body["speaker"]);
  if (!mic || !speaker) return null;
  return {
    phase: body["phase"],
    liveForMs: body["liveForMs"] as number | null,
    mic,
    speaker,
  };
}

function parseChannel(value: unknown): ControlChannelState | null {
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

function parseReadyInfo(value: unknown): SessionReadyInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  if (typeof info["threadId"] !== "string" || typeof info["workspace"] !== "string") return null;
  const prompts = info["prompts"];
  if (!Array.isArray(prompts) || !prompts.every((entry) => typeof entry === "string")) return null;
  for (const key of ["model", "effort", "voiceModel", "voice"] as const) {
    if (info[key] !== null && typeof info[key] !== "string") return null;
  }
  return {
    threadId: info["threadId"],
    workspace: info["workspace"],
    model: info["model"] as string | null,
    effort: info["effort"] as string | null,
    voiceModel: info["voiceModel"] as string | null,
    voice: info["voice"] as string | null,
    prompts: prompts as string[],
  };
}

function isChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRole(value: unknown): value is ControlRole {
  return value === "ui" || value === "voice";
}

function isDb(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value <= 0);
}

function isLiveDuration(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isAudioTarget(value: unknown): value is ControlAudioTarget {
  return value === "mic" || value === "speaker";
}

function isHoldInput(value: unknown): value is ControlUnmuteInput {
  return value === "pointer" || value === "key" || value === "space";
}

function isPhase(value: unknown): value is VoicePhase {
  return (
    value === "waiting-ready" ||
    value === "negotiating" ||
    value === "live" ||
    value === "failed" ||
    value === "stopped"
  );
}
