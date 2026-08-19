import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPinnedWebSocket } from "../src/console/pinned-websocket.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlFrame,
  parseServerFrame,
  type ServerFrame,
} from "../src/core/control-protocol.ts";
import { ControlServer } from "../src/server/control.ts";
import { ensureServerIdentity } from "../src/server/server-identity.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pinned WebSocket transport", () => {
  test("closes exactly once when closed before connect resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentvoice-pinned-ws-close-"));
    directories.push(directory);
    const identity = ensureServerIdentity(directory);
    const server = new ControlServer({
      socketPath: join(directory, "control.sock"),
      network: {
        host: "127.0.0.1",
        port: 0,
        token: "0123456789abcdef0123",
        tls: { key: identity.privateKey, cert: identity.certificate },
      },
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: 1,
        voice: null,
      }),
      onCommand: () => {},
    });
    await server.start();
    const [host, port] = server.networkAddress()!.split(":");
    let opened = false;
    const closes: Array<Error | undefined> = [];

    try {
      const link = connectPinnedWebSocket(
        {
          host: host!,
          port: Number(port),
          ca: identity.certificate,
          serverName: identity.serverName,
          handshakeTimeoutMs: 25,
        },
        {
          onOpen() {
            opened = true;
          },
          onText() {},
          onClose(error) {
            closes.push(error);
          },
        },
      );

      link.close();
      expect(closes).toEqual([undefined]);
      await Bun.sleep(100);
      expect(opened).toBe(false);
      expect(closes).toEqual([undefined]);
    } finally {
      await server.close();
    }
  });

  test("upgrades over a custom-CA TLS socket and exchanges text frames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentvoice-pinned-ws-"));
    directories.push(directory);
    const identity = ensureServerIdentity(directory);
    const server = new ControlServer({
      socketPath: join(directory, "control.sock"),
      network: {
        host: "127.0.0.1",
        port: 0,
        token: "0123456789abcdef0123",
        tls: { key: identity.privateKey, cert: identity.certificate },
      },
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: 7,
        voice: null,
      }),
      onCommand: () => {},
    });
    await server.start();
    const [host, port] = server.networkAddress()!.split(":");
    const frames: ServerFrame[] = [];
    const links: ReturnType<typeof connectPinnedWebSocket>[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("pinned WebSocket test timed out")),
          3_000,
        );
        const link = connectPinnedWebSocket(
          {
            host: host!,
            port: Number(port),
            ca: identity.certificate,
            serverName: identity.serverName,
          },
          {
            onOpen() {},
            onText(text) {
              const frame = parseServerFrame(text);
              if (!frame) return;
              frames.push(frame);
              if (frame.type === "auth-challenge") {
                link.send(
                  encodeControlFrame({
                    type: "hello",
                    protocol: CONTROL_PROTOCOL_VERSION,
                    role: "ui",
                    token: "0123456789abcdef0123",
                  }),
                );
              } else if (frame.type === "state") {
                clearTimeout(timeout);
                resolve();
              }
            },
            onClose(error) {
              clearTimeout(timeout);
              reject(error ?? new Error("pinned WebSocket closed before state"));
            },
          },
        );
        links.push(link);
      });

      expect(frames.map((frame) => frame.type)).toEqual(["auth-challenge", "state"]);
      expect(frames.at(-1)).toMatchObject({ type: "state", sequence: 7 });
    } finally {
      for (const link of links) link.close();
      await server.close();
    }
  });

  test("refuses a Server outside the paired certificate pin", async () => {
    const serverDirectory = await mkdtemp(join(tmpdir(), "agentvoice-pinned-ws-server-"));
    const otherDirectory = await mkdtemp(join(tmpdir(), "agentvoice-pinned-ws-other-"));
    directories.push(serverDirectory, otherDirectory);
    const identity = ensureServerIdentity(serverDirectory);
    const otherIdentity = ensureServerIdentity(otherDirectory);
    const server = new ControlServer({
      socketPath: join(serverDirectory, "control.sock"),
      network: {
        host: "127.0.0.1",
        port: 0,
        token: "0123456789abcdef0123",
        tls: { key: identity.privateKey, cert: identity.certificate },
      },
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: 1,
        voice: null,
      }),
      onCommand: () => {},
    });
    await server.start();
    const [host, port] = server.networkAddress()!.split(":");
    let opened = false;

    try {
      const error = await new Promise<Error>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("pin refusal test timed out")), 3_000);
        connectPinnedWebSocket(
          {
            host: host!,
            port: Number(port),
            ca: otherIdentity.certificate,
            serverName: otherIdentity.serverName,
          },
          {
            onOpen() {
              opened = true;
              clearTimeout(timeout);
              reject(new Error("wrong certificate pin opened"));
            },
            onText() {},
            onClose(closeError) {
              clearTimeout(timeout);
              resolve(closeError ?? new Error("closed without TLS refusal detail"));
            },
          },
        );
      });
      expect(opened).toBe(false);
      expect(error.message.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
