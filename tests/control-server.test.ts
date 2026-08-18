import { describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlState,
  encodeControlFrame,
  parseServerFrame,
  type ServerFrame,
} from "../src/core/control-protocol.ts";
import { type ControlPeerHandle, ControlServer } from "../src/server/control.ts";

function scratchSocket(label: string): string {
  return join(tmpdir(), `av-ctrl-${label}-${process.pid}-${Date.now()}.sock`);
}

function emptyState(): ControlState {
  return { type: "state", protocol: CONTROL_PROTOCOL_VERSION, sequence: 0, voice: null };
}

/** A unix peer with a frame queue: await frames in order, send commands. */
interface TestPeer {
  socket: Socket;
  next(): Promise<ServerFrame>;
  send(command: ControlCommand): void;
  close(): void;
}

function dial(socketPath: string): Promise<TestPeer> {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  const frames: ServerFrame[] = [];
  const waiters: Array<(frame: ServerFrame) => void> = [];
  let buffered = "";
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const frame = parseServerFrame(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (!frame) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  const peer: TestPeer = {
    socket,
    next: () =>
      new Promise((resolve, reject) => {
        const queued = frames.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error("no frame within 2s")), 2000);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    send: (command) => void socket.write(encodeControlFrame(command)),
    close: () => socket.destroy(),
  };
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(peer));
    socket.once("error", reject);
  });
}

function hello(role: "ui" | "voice"): ControlCommand {
  return { type: "hello", protocol: CONTROL_PROTOCOL_VERSION, role };
}

const TOKEN = "0123456789abcdef0123";

/** Resolves on the first frame, so a test can assert a refusal or a welcome. */
function dialWs(address: string): Promise<{ socket: WebSocket; first: Promise<string> }> {
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

describe("control server roles", () => {
  test("a unix peer's commands are dropped until its hello lands", async () => {
    const commands: Array<{ command: ControlCommand; peer: ControlPeerHandle }> = [];
    const socketPath = scratchSocket("hello");
    const server = new ControlServer({
      socketPath,
      state: emptyState,
      onCommand: (command, peer) => commands.push({ command, peer }),
    });
    await server.start();
    try {
      const peer = await dial(socketPath);
      peer.send({ type: "set-muted", target: "mic", muted: true });
      peer.send(hello("ui"));
      const snapshot = await peer.next();
      expect(snapshot.type).toBe("state");
      peer.send({ type: "set-muted", target: "mic", muted: true });
      await Bun.sleep(50);
      expect(commands).toHaveLength(1);
      expect(commands[0]?.command).toEqual({ type: "set-muted", target: "mic", muted: true });
      expect(commands[0]?.peer.role).toBe("ui");
      peer.close();
    } finally {
      await server.close();
    }
  });

  test("a mismatched protocol is told what happened and refused", async () => {
    const socketPath = scratchSocket("proto");
    const server = new ControlServer({
      socketPath,
      state: emptyState,
      onCommand: () => {},
    });
    await server.start();
    try {
      const peer = await dial(socketPath);
      peer.send({ type: "hello", protocol: 7, role: "ui" });
      const frame = await peer.next();
      expect(frame.type).toBe("reject");
      if (frame.type === "reject") expect(frame.reason).toContain("protocol 7");
      peer.close();
    } finally {
      await server.close();
    }
  });

  test("a newer voice hello supersedes the incumbent, which is demoted to ui", async () => {
    const voiceAttached: number[] = [];
    let voiceGone = 0;
    const offers: string[] = [];
    const socketPath = scratchSocket("supersede");
    const server = new ControlServer({
      socketPath,
      state: emptyState,
      onCommand: (command) => {
        if (command.type === "offer") offers.push(command.sdp);
      },
      onVoicePeerAttached: (peer) => voiceAttached.push(peer.id),
      onVoicePeerGone: () => {
        voiceGone++;
      },
    });
    await server.start();
    try {
      const first = await dial(socketPath);
      first.send(hello("voice"));
      await Bun.sleep(50);
      expect(voiceAttached).toHaveLength(1);
      expect(server.hasVoicePeer()).toBe(true);

      const second = await dial(socketPath);
      second.send(hello("voice"));
      const superseded = await first.next();
      expect(superseded.type).toBe("voice-superseded");
      const demotedState = await first.next();
      expect(demotedState.type).toBe("state");
      expect(voiceAttached).toHaveLength(2);
      // The demotion is not a departure: no session teardown fired.
      expect(voiceGone).toBe(0);

      // Voice frames from the demoted peer drop; the successor's dispatch.
      first.send({ type: "offer", sdp: "stale" });
      second.send({ type: "offer", sdp: "fresh" });
      await Bun.sleep(50);
      expect(offers).toEqual(["fresh"]);

      // The demoted ui peer's departure is an ordinary peer close…
      first.close();
      await Bun.sleep(50);
      expect(voiceGone).toBe(0);
      // …while the voice peer's departure tears the session down.
      second.close();
      await Bun.sleep(50);
      expect(voiceGone).toBe(1);
      expect(server.hasVoicePeer()).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("sendToVoicePeer reaches only the voice peer; publish reaches only ui peers", async () => {
    const socketPath = scratchSocket("routes");
    const server = new ControlServer({
      socketPath,
      state: emptyState,
      onCommand: () => {},
    });
    await server.start();
    try {
      expect(server.sendToVoicePeer({ type: "route-redial" })).toBe(false);
      const ui = await dial(socketPath);
      ui.send(hello("ui"));
      expect((await ui.next()).type).toBe("state");
      const voice = await dial(socketPath);
      voice.send(hello("voice"));
      await Bun.sleep(50);

      expect(server.sendToVoicePeer({ type: "route-set-muted", target: "mic", muted: true })).toBe(
        true,
      );
      const routed = await voice.next();
      expect(routed).toEqual({ type: "route-set-muted", target: "mic", muted: true });

      server.publish();
      const published = await ui.next();
      expect(published.type).toBe("state");

      ui.close();
      voice.close();
    } finally {
      await server.close();
    }
  });

  test("admits a network peer only on a matching token and protocol", async () => {
    const commands: string[] = [];
    const server = new ControlServer({
      socketPath: scratchSocket("auth"),
      network: { host: "127.0.0.1", port: 0, token: TOKEN },
      state: emptyState,
      onCommand: (command) => commands.push(command.type),
    });
    await server.start();
    const address = server.networkAddress();
    expect(address).not.toBeNull();

    try {
      // A wrong token is refused in words, and its commands never land.
      const wrong = await dialWs(address!);
      wrong.socket.send(
        encodeControlFrame({
          type: "hello",
          protocol: CONTROL_PROTOCOL_VERSION,
          role: "ui",
          token: "nope",
        }),
      );
      const wrongFrame = parseServerFrame(await wrong.first);
      expect(wrongFrame?.type).toBe("reject");
      if (wrongFrame?.type === "reject") expect(wrongFrame.reason).toBe("token rejected");

      // So is a mismatched protocol — the two ship together.
      const stale = await dialWs(address!);
      stale.socket.send(
        encodeControlFrame({
          type: "hello",
          protocol: CONTROL_PROTOCOL_VERSION - 1,
          role: "ui",
          token: TOKEN,
        }),
      );
      const staleFrame = parseServerFrame(await stale.first);
      expect(staleFrame?.type).toBe("reject");
      if (staleFrame?.type === "reject") expect(staleFrame.reason).toContain("upgrade both");

      // An unauthorized peer's commands are ignored outright: no state is sent
      // before hello, so nothing precedes the refusal on the wire.
      const silent = await dialWs(address!);
      silent.socket.send(encodeControlFrame({ type: "redial" }));
      silent.socket.send(
        encodeControlFrame({
          type: "hello",
          protocol: CONTROL_PROTOCOL_VERSION,
          role: "ui",
          token: TOKEN,
        }),
      );
      expect(parseServerFrame(await silent.first)?.type).toBe("state");
      silent.socket.send(encodeControlFrame({ type: "redial" }));
      await Bun.sleep(50);
      expect(commands).toEqual(["redial"]);
      silent.socket.close();
    } finally {
      await server.close();
    }
  });

  test("releases a silent network peer's holds without waiting for its close", async () => {
    let clock = 10_000;
    const closed: number[] = [];
    const server = new ControlServer({
      socketPath: scratchSocket("beat"),
      network: { host: "127.0.0.1", port: 0, token: TOKEN },
      heartbeatDeadlineMs: 60,
      now: () => clock,
      state: emptyState,
      onCommand: () => {},
      onPeerClose: (peer) => closed.push(peer.id),
    });
    await server.start();
    const address = server.networkAddress();

    try {
      const peer = await dialWs(address!);
      peer.socket.send(
        encodeControlFrame({
          type: "hello",
          protocol: CONTROL_PROTOCOL_VERSION,
          role: "ui",
          token: TOKEN,
        }),
      );
      await peer.first;

      // A beat inside the deadline keeps the hold alive.
      clock += 40;
      peer.socket.send(encodeControlFrame({ type: "ping" }));
      await Bun.sleep(60);
      expect(closed).toHaveLength(0);

      // Silence past it releases, even though the socket is still open — a
      // dead Remote console's TCP close can lag by minutes, and until then
      // the voice peer would still believe a push-to-talk hold were open.
      clock += 200;
      await Bun.sleep(120);
      expect(closed).toHaveLength(1);
      expect(peer.socket.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      await server.close();
    }
  });
});
