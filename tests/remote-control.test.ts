import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientControlServer, type RemoteControlPeer } from "../src/console/remote-control.ts";
import { encodeRemoteMessage, REMOTE_PROTOCOL_VERSION } from "../src/console/remote-protocol.ts";

describe("Remote console control server", () => {
  test("identifies an unmute-hold source and releases it when the peer disconnects", async () => {
    const socketPath = join(tmpdir(), `av-control-${process.pid}-${Date.now()}.sock`);
    let resolveCommand!: (peer: RemoteControlPeer) => void;
    let resolveClose!: (peer: RemoteControlPeer) => void;
    const commandReceived = new Promise<RemoteControlPeer>((resolve) => {
      resolveCommand = resolve;
    });
    const peerClosed = new Promise<RemoteControlPeer>((resolve) => {
      resolveClose = resolve;
    });
    const server = new ClientControlServer({
      socketPath,
      state: () => ({
        type: "state",
        protocol: REMOTE_PROTOCOL_VERSION,
        sequence: 0,
        phase: "live",
        liveForMs: 0,
        mic: { muted: true, effectiveMuted: true, db: null },
        speaker: { muted: false, effectiveMuted: false, db: null },
      }),
      onCommand: (command, peer) => {
        if (command.type !== "hold-unmuted") return;
        resolveCommand(peer);
      },
      onPeerClose: resolveClose,
    });

    await server.start();
    const socket = createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        encodeRemoteMessage({
          type: "hold-unmuted",
          target: "mic",
          input: "pointer",
        }),
      );
      const commandPeer = await commandReceived;

      socket.destroy();
      const closedPeer = await peerClosed;
      expect(closedPeer).toBe(commandPeer);
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});
