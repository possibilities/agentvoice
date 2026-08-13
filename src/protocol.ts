/**
 * The wire protocol between the voice server and its client: JSON text frames
 * over the WebSocket. This module is the single source of truth for message
 * shapes — both sides import it, and the README's protocol tables mirror it.
 */

export const PROTOCOL_VERSION = 1;
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

export type ClientMessage = OfferMessage;

export type ClientParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: "bad-message" | "bad-offer" | "unknown-message"; error: string };

export function parseClientMessage(text: string): ClientParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad-message", error: "messages must be JSON" };
  }
  const message = parsed as Record<string, unknown> | null;
  const type = message?.["type"];
  if (type === "offer") {
    const sdp = message?.["sdp"];
    if (typeof sdp !== "string" || sdp.length === 0) {
      return { ok: false, code: "bad-offer", error: "offer requires a non-empty sdp string" };
    }
    return { ok: true, message: { type: "offer", sdp } };
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

export type ServerMessage =
  | ReadyMessage
  | AnswerMessage
  | ClosedMessage
  | RedialMessage
  | ErrorMessage
  | WorkerUpdateMessage;

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
      return typeof message["sdp"] === "string" ? { type: "answer", sdp: message["sdp"] } : null;
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
    default:
      return null;
  }
}
