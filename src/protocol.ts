/**
 * The wire protocol between the voice server and its client: JSON text frames
 * over the WebSocket. This module is the single source of truth for message
 * shapes — both sides import it, and the README's protocol tables mirror it.
 */

export const PROTOCOL_VERSION = 2;
export const APP_SERVER_GATEWAY_PROTOCOL = 3;
export const AGENTVOICE_THREAD_IDENTITIES_METHOD = "agentvoice/thread/identities";
export const AGENTVOICE_VOICE_OBSERVATION_METHOD = "agentvoice/voice-observation";

export interface AgentVoiceThreadIdentity {
  threadId: string;
  role: "orchestrator" | "worker";
}
/** Close code sent to a second concurrent client. */
export const CLOSE_BUSY = 4429;
/** Close code for a handshake with a missing or wrong connection token. */
export const CLOSE_UNAUTHORIZED = 4401;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export interface OfferMessage {
  type: "offer";
  sdp: string;
}

/** A parsed oai-events data-channel message, preserved as the relay payload. */
export interface OaiEventMessage {
  type: "oai-event";
  voiceSessionId: string;
  sequence: number;
  observedAt: number;
  payload: Record<string, unknown>;
}

/** A contiguous range skipped by the Client's bounded relay queue. */
export interface OaiEventGapMessage {
  type: "oai-event-gap";
  voiceSessionId: string;
  fromSequence: number;
  toSequence: number;
  dropped: number;
  observedAt: number;
}

export type ClientMessage = OfferMessage | OaiEventMessage | OaiEventGapMessage;

export type ClientParseResult =
  | { ok: true; message: ClientMessage }
  | {
      ok: false;
      code: "bad-message" | "bad-offer" | "bad-oai-event" | "bad-oai-event-gap" | "unknown-message";
      error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClientMessage(text: string): ClientParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad-message", error: "messages must be JSON" };
  }
  const message = isRecord(parsed) ? parsed : null;
  const type = message?.["type"];
  if (type === "offer") {
    const sdp = message?.["sdp"];
    if (typeof sdp !== "string" || sdp.length === 0) {
      return { ok: false, code: "bad-offer", error: "offer requires a non-empty sdp string" };
    }
    return { ok: true, message: { type: "offer", sdp } };
  }
  if (type === "oai-event") {
    const voiceSessionId = message?.["voiceSessionId"];
    const sequence = message?.["sequence"];
    const observedAt = message?.["observedAt"];
    const payload = message?.["payload"];
    if (
      typeof voiceSessionId !== "string" ||
      voiceSessionId.length === 0 ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 1 ||
      typeof observedAt !== "number" ||
      !Number.isFinite(observedAt) ||
      !isRecord(payload)
    ) {
      return {
        ok: false,
        code: "bad-oai-event",
        error: "oai-event requires a session id, positive sequence, timestamp, and object payload",
      };
    }
    return {
      ok: true,
      message: {
        type: "oai-event",
        voiceSessionId,
        sequence: sequence as number,
        observedAt,
        payload,
      },
    };
  }
  if (type === "oai-event-gap") {
    const voiceSessionId = message?.["voiceSessionId"];
    const fromSequence = message?.["fromSequence"];
    const toSequence = message?.["toSequence"];
    const dropped = message?.["dropped"];
    const observedAt = message?.["observedAt"];
    if (
      typeof voiceSessionId !== "string" ||
      voiceSessionId.length === 0 ||
      !Number.isSafeInteger(fromSequence) ||
      !Number.isSafeInteger(toSequence) ||
      !Number.isSafeInteger(dropped) ||
      (fromSequence as number) < 1 ||
      (toSequence as number) < (fromSequence as number) ||
      dropped !== (toSequence as number) - (fromSequence as number) + 1 ||
      typeof observedAt !== "number" ||
      !Number.isFinite(observedAt)
    ) {
      return {
        ok: false,
        code: "bad-oai-event-gap",
        error: "oai-event-gap requires one valid contiguous skipped sequence range",
      };
    }
    return {
      ok: true,
      message: {
        type: "oai-event-gap",
        voiceSessionId,
        fromSequence: fromSequence as number,
        toSequence: toSequence as number,
        dropped: dropped as number,
        observedAt,
      },
    };
  }
  return {
    ok: false,
    code: "unknown-message",
    error: `unsupported message type ${JSON.stringify(type ?? null)}`,
  };
}

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Offers are accepted from now until the next closed/fatal error. */
export interface ReadyMessage {
  type: "ready";
  protocol: number;
  threadId: string;
  workspace: string;
  /** null means "codex default". */
  model: string | null;
  effort: string | null;
  voiceModel: string | null;
  voice: string | null;
  /** Prompt files the server found and is priming the agents with. */
  prompts: string[];
}

export interface AnswerMessage {
  type: "answer";
  sdp: string;
  voiceSessionId: string;
}

/** The voice session ended; wait for the next ready, then re-offer if desired. */
export interface ClosedMessage {
  type: "closed";
  reason?: string;
}

/** Replace only the realtime voice session, leaving the socket and thread intact. */
export interface RedialMessage {
  type: "redial";
  reason: string;
}

export type ErrorCode =
  | "not-ready"
  | "bad-message"
  | "bad-offer"
  | "bad-oai-event"
  | "bad-oai-event-gap"
  | "unknown-message"
  | "realtime-failed";

/** fatal:true means the session is dead — close the peer and wait for ready. */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

/** A dispatched worker's lifecycle, for progress UIs. */
export interface WorkerSnapshot {
  /** Speakable handle (w1, w2, …), stable for the worker's lifetime. */
  id: string;
  title: string;
  status: "running" | "completed" | "failed" | "interrupted" | "cancelled" | "lost";
  startedAt: number;
  finishedAt?: number;
  /** The worker's final message, trimmed; present once finished. */
  report?: string;
}

/**
 * Sent on every worker transition, and replayed for known workers when a
 * client connects. Additive: older clients ignore unrecognized types.
 */
export interface WorkerUpdateMessage {
  type: "worker";
  worker: WorkerSnapshot;
}

/** Whether the client should relay parsed oai-events messages to observers. */
export interface ObserveOaiEventsMessage {
  type: "observe-oai-events";
  enabled: boolean;
}

export type ServerMessage =
  | ReadyMessage
  | AnswerMessage
  | ClosedMessage
  | RedialMessage
  | ErrorMessage
  | WorkerUpdateMessage
  | ObserveOaiEventsMessage;

/** Lenient parse for the client: null for anything unrecognized. */
export function parseServerMessage(text: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  switch (message["type"]) {
    case "ready":
      return {
        type: "ready",
        protocol: typeof message["protocol"] === "number" ? message["protocol"] : 0,
        threadId: String(message["threadId"] ?? ""),
        workspace: String(message["workspace"] ?? ""),
        model: (message["model"] as string | null) ?? null,
        effort: (message["effort"] as string | null) ?? null,
        voiceModel: (message["voiceModel"] as string | null) ?? null,
        voice: (message["voice"] as string | null) ?? null,
        prompts: Array.isArray(message["prompts"])
          ? message["prompts"].filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    case "answer":
      return typeof message["sdp"] === "string" && typeof message["voiceSessionId"] === "string"
        ? { type: "answer", sdp: message["sdp"], voiceSessionId: message["voiceSessionId"] }
        : null;
    case "closed":
      return {
        type: "closed",
        ...(typeof message["reason"] === "string" ? { reason: message["reason"] } : {}),
      };
    case "redial":
      return typeof message["reason"] === "string"
        ? { type: "redial", reason: message["reason"] }
        : null;
    case "error":
      return {
        type: "error",
        code: (message["code"] as ErrorCode) ?? "realtime-failed",
        message:
          typeof message["message"] === "string" ? message["message"] : "unknown server error",
        fatal: message["fatal"] === true,
      };
    case "worker": {
      const worker = message["worker"] as Record<string, unknown> | undefined;
      if (typeof worker?.["id"] !== "string" || typeof worker["status"] !== "string") return null;
      return {
        type: "worker",
        worker: {
          id: worker["id"],
          title: typeof worker["title"] === "string" ? worker["title"] : "",
          status: worker["status"] as WorkerSnapshot["status"],
          startedAt: typeof worker["startedAt"] === "number" ? worker["startedAt"] : 0,
          ...(typeof worker["finishedAt"] === "number" ? { finishedAt: worker["finishedAt"] } : {}),
          ...(typeof worker["report"] === "string" ? { report: worker["report"] } : {}),
        },
      };
    }
    case "observe-oai-events":
      return typeof message["enabled"] === "boolean"
        ? { type: "observe-oai-events", enabled: message["enabled"] }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// App-server gateway additive voice observation protocol
// ---------------------------------------------------------------------------

export type VoiceLifecycleState = "starting" | "active" | "ended";
export type VoiceLifecycleReason =
  | "superseded"
  | "upstream-closed"
  | "upstream-error"
  | "client-gone"
  | "app-server-reset"
  | "shutdown";

interface VoiceObservationBase {
  voiceSessionId: string;
  threadId: string;
  observedAt: number;
}

export interface VoiceEventObservation extends VoiceObservationBase {
  kind: "event";
  sequence: number;
  payload: Record<string, unknown>;
}

export interface VoiceLifecycleObservation extends VoiceObservationBase {
  kind: "lifecycle";
  state: VoiceLifecycleState;
  reason?: VoiceLifecycleReason;
}

export interface VoiceGapObservation extends VoiceObservationBase {
  kind: "gap";
  fromSequence: number;
  toSequence: number;
  dropped: number;
}

export type VoiceObservation =
  | VoiceEventObservation
  | VoiceLifecycleObservation
  | VoiceGapObservation;

const VOICE_LIFECYCLE_REASONS = new Set<VoiceLifecycleReason>([
  "superseded",
  "upstream-closed",
  "upstream-error",
  "client-gone",
  "app-server-reset",
  "shutdown",
]);

/** Strict validation for additive gateway notifications and Chats ingestion. */
export function parseVoiceObservation(value: unknown): VoiceObservation | null {
  if (!isRecord(value)) return null;
  const voiceSessionId = value["voiceSessionId"];
  const threadId = value["threadId"];
  const observedAt = value["observedAt"];
  if (
    typeof voiceSessionId !== "string" ||
    voiceSessionId.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt)
  ) {
    return null;
  }
  if (value["kind"] === "event") {
    const sequence = value["sequence"];
    const payload = value["payload"];
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || !isRecord(payload))
      return null;
    return {
      kind: "event",
      voiceSessionId,
      threadId,
      sequence: sequence as number,
      observedAt,
      payload,
    };
  }
  if (value["kind"] === "gap") {
    const fromSequence = value["fromSequence"];
    const toSequence = value["toSequence"];
    const dropped = value["dropped"];
    if (
      !Number.isSafeInteger(fromSequence) ||
      !Number.isSafeInteger(toSequence) ||
      !Number.isSafeInteger(dropped) ||
      (fromSequence as number) < 1 ||
      (toSequence as number) < (fromSequence as number) ||
      dropped !== (toSequence as number) - (fromSequence as number) + 1
    )
      return null;
    return {
      kind: "gap",
      voiceSessionId,
      threadId,
      fromSequence: fromSequence as number,
      toSequence: toSequence as number,
      dropped: dropped as number,
      observedAt,
    };
  }
  if (value["kind"] === "lifecycle") {
    const state = value["state"];
    const reason = value["reason"];
    if (state !== "starting" && state !== "active" && state !== "ended") return null;
    if (state === "ended") {
      if (
        typeof reason !== "string" ||
        !VOICE_LIFECYCLE_REASONS.has(reason as VoiceLifecycleReason)
      )
        return null;
      return {
        kind: "lifecycle",
        voiceSessionId,
        threadId,
        state,
        observedAt,
        reason: reason as VoiceLifecycleReason,
      };
    }
    if (reason !== undefined) return null;
    return { kind: "lifecycle", voiceSessionId, threadId, state, observedAt };
  }
  return null;
}
