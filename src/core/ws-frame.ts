/**
 * Client-side RFC 6455 framing for the resident app-server transport and the
 * pinned network TLS transport. codex serves `--listen unix://` as a WebSocket
 * handshake over the unix stream (tokio-tungstenite `accept_async`), and Bun's
 * native WebSocket cannot dial unix sockets or honor Android's custom CA path,
 * so both transports speak the framing over `Bun.connect`. Pure codec:
 * handshake build/parse and an incremental frame decoder; mask keys are
 * injected so every path is testable.
 */

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Guards runaway memory on a corrupt length header, far above any real frame. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

export function randomMaskKey(): Uint8Array {
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  return mask;
}

export function buildHandshakeRequest(key: string, authority = "localhost"): string {
  return [
    "GET / HTTP/1.1",
    `Host: ${authority}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

/** The Sec-WebSocket-Accept value the server must echo for `key`. */
export function websocketAcceptValue(key: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(key + ACCEPT_GUID);
  return hasher.digest("base64");
}

export type HandshakeParse =
  | { done: false }
  | { done: true; ok: true; acceptValue: string | null; rest: Buffer }
  | { done: true; ok: false; error: string };

/** Parse the HTTP upgrade response; `done: false` means feed more bytes. */
export function parseHandshakeResponse(buffer: Buffer): HandshakeParse {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return { done: false };
  const head = buffer.subarray(0, headerEnd).toString("utf8");
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  if (!/^HTTP\/1\.1 101 /.test(statusLine)) {
    return { done: true, ok: false, error: `handshake rejected: ${statusLine}` };
  }
  let acceptValue: string | null = null;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === "sec-websocket-accept") {
      acceptValue = line.slice(colon + 1).trim();
    }
  }
  return { done: true, ok: true, acceptValue, rest: buffer.subarray(headerEnd + 4) };
}

/** Encode one final (unfragmented) masked client frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, maskKey: Uint8Array): Buffer {
  if (maskKey.length !== 4) throw new Error("mask key must be 4 bytes");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const frame = Buffer.alloc(header.length + 4 + len);
  header.copy(frame, 0);
  frame.set(maskKey, header.length);
  for (let i = 0; i < len; i++) {
    frame[header.length + 4 + i] = ((payload[i] as number) ^ (maskKey[i % 4] as number)) & 0xff;
  }
  return frame;
}

export function encodeTextFrame(text: string, maskKey: Uint8Array): Buffer {
  return encodeFrame(OP_TEXT, new TextEncoder().encode(text), maskKey);
}

export function encodeCloseFrame(code: number, maskKey: Uint8Array): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return encodeFrame(OP_CLOSE, payload, maskKey);
}

export type FrameEvent =
  | { type: "text"; text: string }
  | { type: "binary"; data: Buffer }
  | { type: "ping"; payload: Buffer }
  | { type: "pong" }
  | { type: "close"; code?: number; reason?: string };

interface FrameHeader {
  fin: boolean;
  opcode: number;
  length: number;
  /** Total header bytes including any mask key. */
  headerBytes: number;
  maskKey: Buffer | null;
}

function parseHeader(buffer: Buffer): FrameHeader | null {
  if (buffer.length < 2) return null;
  const b0 = buffer[0] as number;
  const b1 = buffer[1] as number;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;
  let offset = 2;
  let length = len7;
  if (len7 === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len7 === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`frame of ${big} bytes exceeds cap`);
    length = Number(big);
    offset = 10;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  return { fin, opcode, length, headerBytes: offset, maskKey };
}

/**
 * Incremental decoder for server→client frames. Handles partial reads,
 * fragmented messages, and control frames interleaved between fragments.
 * Protocol violations throw; the connection layer treats that as fatal.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;

  feed(chunk: Uint8Array): FrameEvent[] {
    // Copy: the socket layer may reuse the chunk's memory after this call.
    const copied = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? copied : Buffer.concat([this.buffer, copied]);
    const events: FrameEvent[] = [];
    for (;;) {
      const header = parseHeader(this.buffer);
      if (header === null || this.buffer.length < header.headerBytes + header.length) break;
      const payload = Buffer.from(
        this.buffer.subarray(header.headerBytes, header.headerBytes + header.length),
      );
      this.buffer = this.buffer.subarray(header.headerBytes + header.length);
      if (header.maskKey) {
        const key = header.maskKey;
        for (let i = 0; i < payload.length; i++) {
          payload[i] = ((payload[i] as number) ^ (key[i % 4] as number)) & 0xff;
        }
      }
      const event = this.consumeFrame(header, payload);
      if (event) events.push(event);
    }
    return events;
  }

  private consumeFrame(header: FrameHeader, payload: Buffer): FrameEvent | null {
    const { fin, opcode } = header;
    if (opcode === OP_PING) return { type: "ping", payload };
    if (opcode === OP_PONG) return { type: "pong" };
    if (opcode === OP_CLOSE) {
      if (payload.length < 2) return { type: "close" };
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : undefined;
      return {
        type: "close",
        code: payload.readUInt16BE(0),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragmentOpcode !== null) throw new Error("new message interrupted a fragmented one");
      if (fin) {
        return opcode === OP_TEXT
          ? { type: "text", text: payload.toString("utf8") }
          : { type: "binary", data: payload };
      }
      this.fragmentOpcode = opcode;
      this.pushFragment(payload);
      return null;
    }
    if (opcode === OP_CONTINUATION) {
      if (this.fragmentOpcode === null) throw new Error("continuation frame with no message");
      this.pushFragment(payload);
      if (!fin) return null;
      const joined = Buffer.concat(this.fragments);
      const messageOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = null;
      return messageOpcode === OP_TEXT
        ? { type: "text", text: joined.toString("utf8") }
        : { type: "binary", data: joined };
    }
    throw new Error(`unsupported frame opcode 0x${opcode.toString(16)}`);
  }

  private pushFragment(payload: Buffer): void {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      throw new Error(`fragmented message exceeds ${MAX_MESSAGE_BYTES} byte cap`);
    }
    this.fragments.push(payload);
  }
}
