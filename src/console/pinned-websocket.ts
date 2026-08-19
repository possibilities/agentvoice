import type { Socket } from "bun";
import { SocketOutbox } from "../core/socket-outbox.ts";
import {
  buildHandshakeRequest,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  FrameDecoder,
  OP_PONG,
  parseHandshakeResponse,
  randomMaskKey,
  websocketAcceptValue,
} from "../core/ws-frame.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export interface PinnedWebSocketOptions {
  host: string;
  port: number;
  ca: string;
  serverName: string;
  handshakeTimeoutMs?: number;
}

export interface PinnedWebSocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onClose(error?: Error): void;
  debug?(line: string): void;
}

export interface PinnedWebSocketLink {
  send(text: string): void;
  close(): void;
}

/**
 * RFC 6455 over Bun's verified TLS stream. Bun's Android WebSocket client does
 * not currently honor a custom CA, while `Bun.connect` does; keeping framing
 * here preserves the paired certificate pin without moving network policy
 * into the Android host.
 */
export function connectPinnedWebSocket(
  options: PinnedWebSocketOptions,
  handlers: PinnedWebSocketHandlers,
): PinnedWebSocketLink {
  const decoder = new FrameDecoder();
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const key = Buffer.from(keyBytes).toString("base64");
  let socket: Socket | null = null;
  let outbox: SocketOutbox | null = null;
  let handshakeBuffer = Buffer.alloc(0);
  let opened = false;
  let closed = false;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (error?: Error): void => {
    if (closed) return;
    closed = true;
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    try {
      socket?.end();
    } catch {
      // The first failure owns the close notification.
    }
    handlers.onClose(error);
  };

  const writeRaw = (data: Buffer): void => {
    if (closed || !outbox) return;
    outbox.write(data);
  };

  const closeSocket = (): void => {
    if (closed) return;
    if (opened) writeRaw(encodeCloseFrame(1000, randomMaskKey()));
    finish();
  };

  const handleFrames = (data: Uint8Array): void => {
    for (const event of decoder.feed(data)) {
      switch (event.type) {
        case "text":
          handlers.onText(event.text);
          break;
        case "ping":
          writeRaw(encodeFrame(OP_PONG, event.payload, randomMaskKey()));
          break;
        case "close":
          closeSocket();
          break;
        case "binary":
        case "pong":
          break;
      }
    }
  };

  const handleData = (chunk: Uint8Array): void => {
    if (closed) return;
    try {
      if (opened) {
        handleFrames(chunk);
        return;
      }
      handshakeBuffer = Buffer.concat([handshakeBuffer, Buffer.from(chunk)]);
      if (handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
        throw new Error(`pinned WebSocket handshake exceeds ${MAX_HANDSHAKE_BYTES} bytes`);
      }
      const parsed = parseHandshakeResponse(handshakeBuffer);
      if (!parsed.done) return;
      handshakeBuffer = Buffer.alloc(0);
      if (!parsed.ok) throw new Error(parsed.error);
      if (parsed.acceptValue !== websocketAcceptValue(key)) {
        throw new Error("pinned WebSocket handshake accept header missing or mismatched");
      }
      opened = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handlers.onOpen();
      if (parsed.rest.length > 0) handleFrames(parsed.rest);
    } catch (error) {
      finish(asError(error));
    }
  };

  handshakeTimer = setTimeout(
    () => finish(new Error("pinned WebSocket TLS or upgrade handshake timed out")),
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );

  const handleTlsHandshake = (
    connected: Socket,
    success: boolean,
    authorizationError: Error | null,
  ): void => {
    if (closed) {
      connected.end();
      return;
    }
    socket = connected;
    const error = authorizationError ?? connected.getAuthorizationError();
    if (!success || !connected.authorized || error) {
      finish(error ?? new Error("pinned TLS certificate was not authorized"));
      return;
    }
    outbox = new SocketOutbox((data) => connected.write(data));
    handlers.debug?.(`pinned TLS open: ${options.host}:${options.port}`);
    writeRaw(Buffer.from(buildHandshakeRequest(key, `${options.serverName}:${options.port}`)));
  };

  void Bun.connect({
    hostname: options.host,
    port: options.port,
    tls: { ca: options.ca, serverName: options.serverName, rejectUnauthorized: true },
    socket: {
      handshake: handleTlsHandshake,
      data: (_socket, chunk) => handleData(chunk),
      drain: () => outbox?.flush(),
      close: () => finish(),
      error: (_socket, error) => finish(error),
    },
  })
    .then((connected) => {
      if (closed) {
        connected.end();
        return;
      }
      socket ??= connected;
    })
    .catch((error) => finish(asError(error)));

  return {
    send(text) {
      if (!opened || closed) return;
      writeRaw(encodeTextFrame(text, randomMaskKey()));
    },
    close: closeSocket,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
