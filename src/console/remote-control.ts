import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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
  onCommand(command: RemoteCommand, peer: RemoteControlPeer): void;
  onPeerClose?(peer: RemoteControlPeer): void;
}

export interface RemoteControlPeer {
  readonly id: number;
}

export class ClientControlServer {
  private readonly peers = new Map<Socket, RemoteControlPeer>();
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private identity: { dev: number; ino: number } | null = null;
  private nextPeerId = 1;

  constructor(private readonly options: ClientControlServerOptions) {}

  async start(): Promise<void> {
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    // The lock serializes stale-cleanup-and-bind: without it, two consoles
    // racing after a crash can both classify the same inode stale, and the
    // second unlink removes the winner's freshly bound socket — leaving two
    // consoles sharing one orchestrator agent.
    const releaseLock = acquireStartLock(`${this.options.socketPath}.lock`);
    try {
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
    } finally {
      releaseLock();
    }
  }

  publish(): void {
    const frame = encodeRemoteMessage(this.options.state());
    for (const peer of this.peers.keys()) {
      if (!peer.destroyed && !peer.writableNeedDrain) peer.write(frame);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const peer of [...this.peers.keys()]) {
      this.dropPeer(peer);
      peer.destroy();
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    removeOwnedSocket(this.options.socketPath, this.identity);
    this.identity = null;
  }

  private accept(peer: Socket): void {
    const identity = Object.freeze({ id: this.nextPeerId++ });
    this.peers.set(peer, identity);
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
        if (command) this.options.onCommand(command, identity);
      }
    });
    peer.on("close", () => this.dropPeer(peer));
    peer.on("error", () => this.dropPeer(peer));
    peer.write(encodeRemoteMessage(this.options.state()));
  }

  private dropPeer(peer: Socket): void {
    const identity = this.peers.get(peer);
    if (!identity) return;
    this.peers.delete(peer);
    this.options.onPeerClose?.(identity);
  }
}

/**
 * O_EXCL pid lockfile around the socket's cleanup-and-bind window. A dead
 * holder's lock is broken by pid liveness; two breakers racing converge —
 * exactly one recreates the file, the other reads a live pid and refuses.
 */
function acquireStartLock(lockPath: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // released is released
        }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let holder: number | null = null;
      try {
        holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      } catch {
        // unreadable → treat as stale
      }
      if (holder !== null && Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new Error(
          `another AgentVoice console is starting (start lock held by pid ${holder})`,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // raced another lock breaker; the retry decides
      }
    }
  }
  throw new Error("could not acquire the console start lock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists under another uid — alive either way.
    return (error as { code?: string }).code === "EPERM";
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
