/**
 * The wire protocol between the voice server and its client: JSON text frames
 * over the WebSocket. This module is the single source of truth for message
 * shapes — both sides import it, and the README's protocol tables mirror it.
 */

export const PROTOCOL_VERSION = 1;
/** Close code sent to a second concurrent client. */
export const CLOSE_BUSY = 4429;

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

export type ServerMessage = ReadyMessage | AnswerMessage | ClosedMessage | ErrorMessage;

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
    case "error":
      return {
        type: "error",
        code: (message["code"] as ErrorCode) ?? "realtime-failed",
        message:
          typeof message["message"] === "string" ? message["message"] : "unknown server error",
        fatal: message["fatal"] === true,
      };
    default:
      return null;
  }
}
