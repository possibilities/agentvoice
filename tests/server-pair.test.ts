import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  encodeControlFrame,
  parseControlCommand,
} from "../src/core/control-protocol.ts";
import { pairWithServer } from "../src/server/pair.ts";

const servers: Array<{ server: Server; sockets: Set<Socket> }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async ({ server, sockets }) => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("server pair command", () => {
  test("opens locally, asks once for the matching code, and confirms the session", async () => {
    const commands: ControlCommand[] = [];
    const socketPath = join(tmpdir(), `agentvoice-pair-cli-${process.pid}-${Date.now()}.sock`);
    await fakePairingServer(socketPath, commands);
    const output: string[] = [];
    const confirmations: Array<[string, string]> = [];
    const result = await pairWithServer(socketPath, {
      write: (line) => output.push(line),
      confirm: async (code, deviceName) => {
        confirmations.push([code, deviceName]);
        return true;
      },
      timeoutMs: 2_000,
    });

    expect(result).toBe(0);
    expect(confirmations).toEqual([["123 456", "Samsung"]]);
    expect(commands.map((command) => command.type)).toEqual([
      "hello",
      "pairing-open",
      "pairing-local-confirm",
    ]);
    expect(output.join("\n")).toContain("Samsung paired");
  });

  test("settles and closes cleanly when interactive confirmation fails", async () => {
    const commands: ControlCommand[] = [];
    const socketPath = join(
      tmpdir(),
      `agentvoice-pair-cli-reject-${process.pid}-${Date.now()}.sock`,
    );
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    await fakePairingServer(socketPath, commands, closed);
    const output: string[] = [];

    await expect(
      pairWithServer(socketPath, {
        write: (line) => output.push(line),
        confirm: async () => {
          throw new Error("terminal input failed");
        },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("terminal input failed");
    await socketClosed;

    expect(output).not.toContain("Server closed before pairing completed");
  });
});

async function fakePairingServer(
  socketPath: string,
  commands: ControlCommand[],
  onSocketClose?: () => void,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const command = parseControlCommand(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (!command) continue;
        commands.push(command);
        if (command.type === "hello") {
          socket.write(
            encodeControlFrame({
              type: "state",
              protocol: CONTROL_PROTOCOL_VERSION,
              sequence: 0,
              voice: null,
            }),
          );
        } else if (command.type === "pairing-open") {
          socket.write(
            encodeControlFrame({
              type: "pairing-state",
              status: "open",
              expiresAt: Date.now() + 120_000,
            }),
          );
          socket.write(
            encodeControlFrame({
              type: "pairing-state",
              status: "awaiting-confirmation",
              expiresAt: Date.now() + 120_000,
              sessionId: "session",
              code: "123 456",
              deviceName: "Samsung",
            }),
          );
        } else if (command.type === "pairing-local-confirm") {
          socket.write(
            encodeControlFrame({
              type: "pairing-state",
              status: "complete",
              deviceName: "Samsung",
            }),
          );
        }
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      onSocketClose?.();
    });
  });
  servers.push({ server, sockets });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}
