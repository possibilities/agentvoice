import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE_BYTES = 16 << 10;
const MAX_MESSAGE_BYTES = 16 << 20;
const MAX_BUFFERED_BYTES = 16 << 20;

export interface UnixWebSocketOptions {
  socketPath: string;
  onText(text: string): void;
  onClose(info: { code: number; reason: string }): void;
  onError?(error: Error): void;
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, headerLength);
  for (let index = 0; index < length; index++) {
    frame[headerLength + 4 + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

/**
 * Minimal RFC 6455 client for Codex's owner-only Unix listener. Bun's native
 * WebSocket client cannot dial Unix sockets, while the listener deliberately
 * requires a WebSocket upgrade rather than accepting raw JSON lines.
 */
export class UnixWebSocket {
  private readonly options: UnixWebSocketOptions;
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private open = false;
  private closing = false;
  private closed = false;

  constructor(options: UnixWebSocketOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.open && !this.closing && !this.closed;
  }

  connect(timeoutMs = 5_000): Promise<void> {
    if (this.socket) return Promise.reject(new Error("Unix WebSocket already started"));
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const socket = createConnection({ path: this.options.socketPath });
      this.socket = socket;
      let handshake = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        const error = new Error(`timed out connecting to ${this.options.socketPath}`);
        rejectOnce(error);
        socket.destroy();
      }, timeoutMs);
      const rejectOnce = (error: Error) => {
        if (settled) {
          this.options.onError?.(error);
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      socket.once("connect", () => {
        socket.write(
          [
            "GET /rpc HTTP/1.1",
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        if (this.open) {
          this.receive(chunk);
          return;
        }
        handshake = Buffer.concat([handshake, chunk]);
        if (handshake.length > MAX_HANDSHAKE_BYTES) {
          rejectOnce(new Error("Unix WebSocket handshake exceeded 16 KiB"));
          socket.destroy();
          return;
        }
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const head = handshake.subarray(0, boundary).toString("latin1");
        const lines = head.split("\r\n");
        const status = lines.shift() ?? "";
        const headers = new Map<string, string>();
        for (const line of lines) {
          const separator = line.indexOf(":");
          if (separator < 0) continue;
          headers.set(
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim(),
          );
        }
        if (!/^HTTP\/1\.1 101\b/.test(status)) {
          rejectOnce(new Error(`Unix WebSocket upgrade failed: ${status || "empty response"}`));
          socket.destroy();
          return;
        }
        if (headers.get("sec-websocket-accept") !== websocketAccept(key)) {
          rejectOnce(new Error("Unix WebSocket upgrade returned the wrong accept key"));
          socket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.open = true;
        resolve();
        const rest = handshake.subarray(boundary + 4);
        if (rest.length > 0) this.receive(rest);
      });
      socket.on("error", (cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        rejectOnce(error);
      });
      socket.on("close", () => this.finishClose(1006, "connection closed"));
    });
  }

  sendText(text: string): void {
    this.writeFrame(0x1, Buffer.from(text));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    const socket = this.socket;
    if (!socket || !this.open) {
      socket?.destroy();
      this.finishClose(code, reason);
      return;
    }
    try {
      socket.write(clientFrame(0x8, closePayload(code, reason)));
      socket.end();
    } catch {
      socket.destroy();
    }
  }

  terminate(): void {
    this.socket?.destroy();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (!socket || !this.isOpen) throw new Error("Unix WebSocket is not open");
    if (payload.length > MAX_MESSAGE_BYTES) throw new Error("WebSocket message exceeds 16 MiB");
    if (socket.writableLength + payload.length > MAX_BUFFERED_BYTES) {
      socket.destroy(new Error("Unix WebSocket backpressure limit exceeded"));
      throw new Error("Unix WebSocket backpressure limit exceeded");
    }
    socket.write(clientFrame(opcode, payload));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if ((first & 0x70) !== 0 || masked) {
        this.protocolError("invalid server frame flags");
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_MESSAGE_BYTES)) {
          this.protocolError("server message exceeds 16 MiB");
          return;
        }
        length = Number(longLength);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.protocolError("server message exceeds 16 MiB");
        return;
      }
      if (opcode >= 0x8 && (!final || length > 125)) {
        this.protocolError("invalid WebSocket control frame");
        return;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (!this.handleFrame(opcode, final, payload)) return;
    }
  }

  private handleFrame(opcode: number, final: boolean, payload: Buffer): boolean {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
      if (!this.closing && this.socket) {
        this.closing = true;
        this.socket.write(clientFrame(0x8, payload));
        this.socket.end();
      }
      this.finishClose(code, reason);
      return false;
    }
    if (opcode === 0x9) {
      this.writeFrame(0x0a, payload);
      return true;
    }
    if (opcode === 0x0a) return true;
    if (opcode === 0x2) {
      this.protocolError("binary messages are unsupported");
      return false;
    }
    if (opcode === 0x1) {
      if (this.fragmentOpcode !== null) {
        this.protocolError("new data frame during fragmented message");
        return false;
      }
      if (final) return this.deliverText(payload);
      this.fragmentOpcode = opcode;
      this.fragments = [Buffer.from(payload)];
      return true;
    }
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) {
        this.protocolError("continuation without an initial frame");
        return false;
      }
      this.fragments.push(Buffer.from(payload));
      const size = this.fragments.reduce((total, fragment) => total + fragment.length, 0);
      if (size > MAX_MESSAGE_BYTES) {
        this.protocolError("fragmented message exceeds 16 MiB");
        return false;
      }
      if (!final) return true;
      const complete = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentOpcode = null;
      return this.deliverText(complete);
    }
    this.protocolError(`unsupported WebSocket opcode ${opcode}`);
    return false;
  }

  private deliverText(payload: Buffer): boolean {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      this.options.onText(text);
      return true;
    } catch {
      this.protocolError("invalid UTF-8 text message");
      return false;
    }
  }

  private protocolError(reason: string): void {
    this.options.onError?.(new Error(reason));
    this.close(1002, reason);
  }

  private finishClose(code: number, reason: string): void {
    if (this.closed) return;
    const notify = this.open;
    this.closed = true;
    this.open = false;
    if (notify) this.options.onClose({ code, reason });
  }
}
