/**
 * The console's attachment to the resident app-server: JSON-RPC 2.0 over
 * WebSocket framing over the resident's `--listen unix://` socket. Mirrors
 * the stdio client's contract — request/notify, notification fan-out, and
 * fail-closed denial of unhandled server→client requests — with connection
 * loss surfaced through `onClose` for the runtime to redial.
 */
import type { Socket } from "bun";
import { AppServerError, buildDenialResponse, DEFAULT_REQUEST_TIMEOUT_MS } from "./appserver.ts";
import {
  buildHandshakeRequest,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  FrameDecoder,
  OP_PONG,
  parseHandshakeResponse,
  websocketAcceptValue,
} from "./ws-frame.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface AttachOptions {
  socketPath: string;
  clientVersion: string;
  onNotification(method: string, params: Record<string, unknown>): void;
  /**
   * Optional answerer for server→client requests. Return a promise resolving
   * to the response payload, or null (or reject) to fall back to the
   * fail-closed denial. Absent means every request is denied.
   */
  onRequest?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null;
  /** Called exactly once when the attachment ends, however it ends. */
  onClose(info: { expected: boolean; error?: string }): void;
  debug?(line: string): void;
}

function randomMask(): Uint8Array {
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  return mask;
}

export class ResidentAttachment {
  private readonly options: AttachOptions;
  private socket: Socket | null = null;
  private readonly decoder = new FrameDecoder();
  private handshakeBuffer: Buffer = Buffer.alloc(0);
  private handshake: { key: string; resolve(): void; reject(error: Error): void } | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closing = false;

  private constructor(options: AttachOptions) {
    this.options = options;
  }

  /** Connect, upgrade, and run the `initialize` handshake. */
  static async connect(options: AttachOptions): Promise<ResidentAttachment> {
    const attachment = new ResidentAttachment(options);
    await attachment.open();
    await attachment.request("initialize", {
      clientInfo: { name: "agentvoice", title: "AgentVoice", version: options.clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    attachment.notify("initialized", {});
    return attachment;
  }

  get alive(): boolean {
    return this.socket !== null && !this.closed;
  }

  private async open(): Promise<void> {
    const keyBytes = new Uint8Array(16);
    crypto.getRandomValues(keyBytes);
    const key = Buffer.from(keyBytes).toString("base64");

    let socket: Socket;
    try {
      socket = await Bun.connect({
        unix: this.options.socketPath,
        socket: {
          data: (_socket, chunk) => this.handleData(chunk),
          close: () => this.handleClose(),
          error: (_socket, error) => this.fail(error.message),
        },
      });
    } catch (error) {
      throw new AppServerError(
        `cannot reach the resident app-server at ${this.options.socketPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshake = null;
        reject(new AppServerError("websocket handshake timed out"));
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshake = {
        key,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      socket.write(buildHandshakeRequest(key));
    });
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new AppServerError(`${method}: not attached to the app-server`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new AppServerError(
            `${method}: failed to write to app-server: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Graceful detach: close frame, then socket end. The resident lives on. */
  close(): void {
    this.closing = true;
    const socket = this.socket;
    if (!socket || this.closed) return;
    try {
      socket.write(encodeCloseFrame(1000, randomMask()));
      socket.end();
    } catch {
      // the close handler owns the rest
    }
  }

  // -------------------------------------------------------------------------

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || this.closed) throw new AppServerError("not attached to the app-server");
    const text = JSON.stringify(message);
    this.options.debug?.(`-> ${text}`);
    socket.write(encodeTextFrame(text, randomMask()));
  }

  private handleData(chunk: Uint8Array): void {
    try {
      let payload: Uint8Array = chunk;
      if (this.handshake) {
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, Buffer.from(chunk)]);
        const parsed = parseHandshakeResponse(this.handshakeBuffer);
        if (!parsed.done) return;
        const handshake = this.handshake;
        this.handshake = null;
        this.handshakeBuffer = Buffer.alloc(0);
        if (!parsed.ok) {
          handshake.reject(new AppServerError(parsed.error));
          return;
        }
        if (
          parsed.acceptValue !== null &&
          parsed.acceptValue !== websocketAcceptValue(handshake.key)
        ) {
          handshake.reject(new AppServerError("websocket handshake accept mismatch"));
          return;
        }
        handshake.resolve();
        if (parsed.rest.length === 0) return;
        payload = parsed.rest;
      }
      for (const event of this.decoder.feed(payload)) {
        if (event.type === "text") {
          this.dispatchText(event.text);
        } else if (event.type === "ping") {
          this.socket?.write(encodeFrame(OP_PONG, event.payload, randomMask()));
        } else if (event.type === "close") {
          this.closing = true;
          try {
            this.socket?.write(encodeCloseFrame(1000, randomMask()));
            this.socket?.end();
          } catch {
            // already closing
          }
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private dispatchText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.options.debug?.(`dropping non-JSON frame: ${text.slice(0, 120)}`);
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;
    this.options.debug?.(`<- ${text}`);
    const { id, method } = message;

    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      clearTimeout(pending.timer);
      const error = message["error"] as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new AppServerError(
            `${pending.method}: ${error.message ?? "unknown app-server error"}`,
            error.code,
          ),
        );
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }

    if (id !== undefined && typeof method === "string") {
      // Server→client request. A handler may answer it (dispatch tool calls);
      // everything else — and a handler that declines or throws — fail-closes
      // with an immediate denial so no request ever parks a turn.
      const requestId = id as number | string;
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      const handled = this.options.onRequest?.(method, params);
      if (handled) {
        handled
          .then((response) => {
            this.respond(requestId, response ?? buildDenialResponse(method));
          })
          .catch(() => {
            this.respond(requestId, buildDenialResponse(method));
          });
      } else {
        this.respond(requestId, buildDenialResponse(method));
      }
      return;
    }

    if (typeof method === "string") {
      this.options.onNotification(method, (message["params"] ?? {}) as Record<string, unknown>);
    }
  }

  private respond(id: number | string, result: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", id, result });
    } catch {
      // detached mid-answer; the request dies with the connection
    }
  }

  private fail(error: string): void {
    this.options.debug?.(`attachment failed: ${error}`);
    const handshake = this.handshake;
    if (handshake) {
      this.handshake = null;
      handshake.reject(new AppServerError(error));
    }
    try {
      this.socket?.end();
    } catch {
      // already gone
    }
    this.finish(false, error);
  }

  private handleClose(): void {
    const handshake = this.handshake;
    if (handshake) {
      this.handshake = null;
      handshake.reject(new AppServerError("connection closed during handshake"));
    }
    this.finish(this.closing);
  }

  private finish(expected: boolean, error?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(`${pending.method}: attachment to app-server closed`));
    }
    this.pending.clear();
    this.options.onClose({ expected, ...(error !== undefined ? { error } : {}) });
  }
}
