import { describe, expect, test } from "bun:test";
import {
  buildHandshakeRequest,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  FrameDecoder,
  OP_BINARY,
  OP_CLOSE,
  OP_CONTINUATION,
  OP_PING,
  OP_TEXT,
  parseHandshakeResponse,
  websocketAcceptValue,
} from "../src/server/ws-frame.ts";

const MASK = new Uint8Array([0x12, 0x34, 0x56, 0x78]);

/** Server→client frames are unmasked. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

describe("handshake", () => {
  test("accept value matches the RFC 6455 vector", () => {
    expect(websocketAcceptValue("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("request carries the key and terminates the header block", () => {
    const request = buildHandshakeRequest("abc123");
    expect(request).toContain("Sec-WebSocket-Key: abc123\r\n");
    expect(request.endsWith("\r\n\r\n")).toBe(true);
  });

  test("incomplete response asks for more bytes", () => {
    expect(parseHandshakeResponse(Buffer.from("HTTP/1.1 101 Switching"))).toEqual({ done: false });
  });

  test("101 response yields the accept value and preserves trailing bytes", () => {
    const trailing = serverFrame(OP_TEXT, new TextEncoder().encode("hi"));
    const response = Buffer.concat([
      Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: xyz=\r\n\r\n",
      ),
      trailing,
    ]);
    const parsed = parseHandshakeResponse(response);
    if (!parsed.done || !parsed.ok) throw new Error("expected a successful parse");
    expect(parsed.acceptValue).toBe("xyz=");
    expect(Buffer.compare(parsed.rest, trailing)).toBe(0);
  });

  test("non-101 response is an error", () => {
    const parsed = parseHandshakeResponse(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
    if (!parsed.done || parsed.ok) throw new Error("expected a rejected parse");
    expect(parsed.error).toContain("400");
  });
});

describe("frame round trips", () => {
  for (const size of [0, 5, 125, 126, 65535, 65536]) {
    test(`masked text frame of ${size} bytes decodes`, () => {
      const text = "x".repeat(size);
      const decoder = new FrameDecoder();
      const events = decoder.feed(encodeTextFrame(text, MASK));
      expect(events).toEqual([{ type: "text", text }]);
    });
  }

  test("close frame round trips code", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed(encodeCloseFrame(1000, MASK))).toEqual([{ type: "close", code: 1000 }]);
  });

  test("binary frame decodes", () => {
    const payload = new Uint8Array([1, 2, 3, 255]);
    const decoder = new FrameDecoder();
    const events = decoder.feed(encodeFrame(OP_BINARY, payload, MASK));
    expect(events).toEqual([{ type: "binary", data: Buffer.from(payload) }]);
  });
});

describe("decoder", () => {
  test("byte-by-byte feeding produces one event at the end", () => {
    const frame = serverFrame(OP_TEXT, new TextEncoder().encode("hello"));
    const decoder = new FrameDecoder();
    const events: unknown[] = [];
    for (const byte of frame) events.push(...decoder.feed(new Uint8Array([byte])));
    expect(events).toEqual([{ type: "text", text: "hello" }]);
  });

  test("several frames in one chunk all decode", () => {
    const chunk = Buffer.concat([
      serverFrame(OP_TEXT, new TextEncoder().encode("one")),
      serverFrame(OP_TEXT, new TextEncoder().encode("two")),
    ]);
    const decoder = new FrameDecoder();
    expect(decoder.feed(chunk)).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });

  test("fragmented text with an interleaved ping reassembles", () => {
    const decoder = new FrameDecoder();
    const events = decoder.feed(
      Buffer.concat([
        serverFrame(OP_TEXT, new TextEncoder().encode("hel"), false),
        serverFrame(OP_PING, new Uint8Array([9])),
        serverFrame(OP_CONTINUATION, new TextEncoder().encode("lo"), true),
      ]),
    );
    expect(events).toEqual([
      { type: "ping", payload: Buffer.from([9]) },
      { type: "text", text: "hello" },
    ]);
  });

  test("close with code and reason decodes both", () => {
    const payload = Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from("going away")]);
    const decoder = new FrameDecoder();
    expect(decoder.feed(serverFrame(OP_CLOSE, payload))).toEqual([
      { type: "close", code: 1001, reason: "going away" },
    ]);
  });

  test("continuation with no message in flight throws", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.feed(serverFrame(OP_CONTINUATION, new Uint8Array([1])))).toThrow(
      "continuation",
    );
  });

  test("a new message interrupting a fragmented one throws", () => {
    const decoder = new FrameDecoder();
    decoder.feed(serverFrame(OP_TEXT, new TextEncoder().encode("a"), false));
    expect(() => decoder.feed(serverFrame(OP_TEXT, new TextEncoder().encode("b"), true))).toThrow(
      "interrupted",
    );
  });

  test("multi-byte UTF-8 split across fragments decodes intact", () => {
    const bytes = new TextEncoder().encode("é");
    const decoder = new FrameDecoder();
    decoder.feed(serverFrame(OP_TEXT, bytes.subarray(0, 1), false));
    const events = decoder.feed(serverFrame(OP_CONTINUATION, bytes.subarray(1), true));
    expect(events).toEqual([{ type: "text", text: "é" }]);
  });
});
