import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
  type RemoteCommand,
  type RemoteState,
} from "./remote-protocol.ts";

const MAX_BUFFER_BYTES = 8 * 1024;
const PUBLISH_INTERVAL_MS = 100;

export interface ClientControlServerOptions {
  socketPath: string;
  state(): RemoteState;
  onCommand(command: RemoteCommand): void;
}

export class ClientControlServer {
  private readonly peers = new Set<Socket>();
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private identity: { dev: number; ino: number } | null = null;

  constructor(private readonly options: ClientControlServerOptions) {}

  async start(): Promise<void> {
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);
    const server = createServer((peer) => this.accept(peer));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    chmodSync(this.options.socketPath, 0o600);
    const stat = lstatSync(this.options.socketPath);
    if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("client control socket permissions are unsafe");
    }
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.server = server;
    this.timer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
    this.timer.unref?.();
  }

  publish(): void {
    const frame = encodeRemoteMessage(this.options.state());
    for (const peer of this.peers) {
      if (!peer.destroyed && !peer.writableNeedDrain) peer.write(frame);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    removeOwnedSocket(this.options.socketPath, this.identity);
    this.identity = null;
  }

  private accept(peer: Socket): void {
    this.peers.add(peer);
    let buffered = "";
    peer.setEncoding("utf8");
    peer.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_BUFFER_BYTES) {
        peer.destroy();
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const command = parseRemoteCommand(line);
        if (command) this.options.onCommand(command);
      }
    });
    peer.on("close", () => this.peers.delete(peer));
    peer.on("error", () => this.peers.delete(peer));
    peer.write(encodeRemoteMessage(this.options.state()));
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const before = lstatSync(path);
  if (
    !before.isSocket() ||
    before.isSymbolicLink() ||
    (process.getuid && before.uid !== process.getuid()) ||
    (before.mode & 0o077) !== 0
  ) {
    throw new Error(`refusing unsafe existing client control socket: ${path}`);
  }
  const active = await socketAcceptsConnections(path);
  if (active) throw new Error("another AgentVoice client already owns the control socket");
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isSocket()) {
    throw new Error("client control socket changed during stale cleanup");
  }
  unlinkSync(path);
}

function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function removeOwnedSocket(path: string, identity: { dev: number; ino: number } | null): void {
  if (!identity || !existsSync(path)) return;
  const current = lstatSync(path);
  if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
    unlinkSync(path);
  }
}
