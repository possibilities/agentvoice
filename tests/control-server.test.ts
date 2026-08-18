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
});
