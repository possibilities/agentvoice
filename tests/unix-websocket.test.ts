import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixWebSocket } from "../src/server/unix-websocket.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length >= 126) throw new Error("fixture only supports compact frames");
  return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
}

function decodeClientText(frame: Buffer): string {
  const length = frame[1]! & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, 6 + length));
  for (let index = 0; index < payload.length; index++) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return payload.toString();
}

async function fixture(): Promise<{
  path: string;
  received: Promise<string>;
}> {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-unix-ws-"));
  roots.push(root);
  const path = join(root, "control.sock");
  let resolveReceived: (text: string) => void = () => {};
  const received = new Promise<string>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((socket: Socket) => {
    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk]);
      const boundary = handshake.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.off("data", onHandshake);
      const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(handshake.toString())?.[1]?.trim();
      if (!key) throw new Error("missing key");
      const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (frame: Buffer) => {
        if ((frame[0]! & 0x0f) !== 0x1) return;
        resolveReceived(decodeClientText(frame));
        socket.write(serverFrame(0x1, Buffer.from('{"reply":true}')));
      });
    };
    socket.on("data", onHandshake);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, received };
}

describe("UnixWebSocket", () => {
  test("upgrades over a Unix socket and exchanges masked text frames", async () => {
    const { path, received } = await fixture();
    let resolveReply: (text: string) => void = () => {};
    const reply = new Promise<string>((resolve) => {
      resolveReply = resolve;
    });
    const ws = new UnixWebSocket({
      socketPath: path,
      onText: resolveReply,
      onClose() {},
    });
    await ws.connect();
    ws.sendText('{"request":true}');
    expect(await received).toBe('{"request":true}');
    expect(await reply).toBe('{"reply":true}');
    ws.close();
  });
});
