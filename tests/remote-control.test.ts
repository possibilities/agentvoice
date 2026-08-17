import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientControlServer, type RemoteControlPeer } from "../src/console/remote-control.ts";
import {
  encodeRemoteMessage,
  parseRemoteReject,
  parseRemoteState,
  REMOTE_PROTOCOL_VERSION,
  type RemoteState,
} from "../src/console/remote-protocol.ts";

const TOKEN = "0123456789abcdef0123";

function state(): RemoteState {
  return {
    type: "state",
    protocol: REMOTE_PROTOCOL_VERSION,
    sequence: 0,
    phase: "live",
    liveForMs: 0,
    mic: { muted: true, effectiveMuted: true, db: null },
    speaker: { muted: false, effectiveMuted: false, db: null },
  };
}

function scratchSocket(label: string): string {
  return join(tmpdir(), `av-control-${label}-${process.pid}-${Date.now()}.sock`);
}

/** Resolves on the first frame, so a test can assert a refusal or a welcome. */
function dial(address: string): Promise<{ socket: WebSocket; first: Promise<string> }> {
  const socket = new WebSocket(`ws://${address}`);
  const first = new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener("close", () => reject(new Error("closed before any frame")), {
      once: true,
    });
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ socket, first }), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not dial")), { once: true });
  });
}

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

  test("admits a network peer only on a matching token and protocol", async () => {
    const commands: string[] = [];
    const server = new ClientControlServer({
      socketPath: scratchSocket("auth"),
      network: { host: "127.0.0.1", port: 0, token: TOKEN },
      state,
      onCommand: (command) => commands.push(command.type),
    });
    await server.start();
    const address = server.networkAddress();
    expect(address).not.toBeNull();

    try {
      // A wrong token is refused in words, and its commands never land.
      const wrong = await dial(address!);
      wrong.socket.send(
        encodeRemoteMessage({ type: "hello", protocol: REMOTE_PROTOCOL_VERSION, token: "nope" }),
      );
      expect(parseRemoteReject(await wrong.first)?.reason).toBe("token rejected");

      // So is a mismatched protocol — the two ship together.
      const stale = await dial(address!);
      stale.socket.send(
        encodeRemoteMessage({
          type: "hello",
          protocol: REMOTE_PROTOCOL_VERSION - 1,
          token: TOKEN,
        }),
      );
      expect(parseRemoteReject(await stale.first)?.reason).toContain("upgrade both");

      // An unauthorized peer's commands are ignored outright: no state is sent
      // before hello, so nothing precedes the refusal on the wire.
      const silent = await dial(address!);
      silent.socket.send(encodeRemoteMessage({ type: "redial" }));
      silent.socket.send(
        encodeRemoteMessage({ type: "hello", protocol: REMOTE_PROTOCOL_VERSION, token: TOKEN }),
      );
      expect(parseRemoteState(await silent.first)?.phase).toBe("live");
      silent.socket.send(encodeRemoteMessage({ type: "redial" }));
      await Bun.sleep(50);
      expect(commands).toEqual(["redial"]);
      silent.socket.close();
    } finally {
      await server.close();
    }
  });

  test("releases a silent network peer's holds without waiting for its close", async () => {
    let clock = 10_000;
    const closed: RemoteControlPeer[] = [];
    const server = new ClientControlServer({
      socketPath: scratchSocket("beat"),
      network: { host: "127.0.0.1", port: 0, token: TOKEN },
      heartbeatDeadlineMs: 60,
      now: () => clock,
      state,
      onCommand: () => {},
      onPeerClose: (peer) => closed.push(peer),
    });
    await server.start();
    const address = server.networkAddress();

    try {
      const peer = await dial(address!);
      peer.socket.send(
        encodeRemoteMessage({ type: "hello", protocol: REMOTE_PROTOCOL_VERSION, token: TOKEN }),
      );
      await peer.first;

      // A beat inside the deadline keeps the hold alive.
      clock += 40;
      peer.socket.send(encodeRemoteMessage({ type: "ping" }));
      await Bun.sleep(60);
      expect(closed).toHaveLength(0);

      // Silence past it releases, even though the socket is still open — a
      // dead Remote console's TCP close can lag by minutes, and until then the
      // Console would still believe a push-to-talk hold were open.
      clock += 200;
      await Bun.sleep(120);
      expect(closed).toHaveLength(1);
      expect(peer.socket.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      await server.close();
    }
  });
});
