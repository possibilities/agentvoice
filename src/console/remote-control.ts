/**
 * The Console's control surface for Remote consoles, served over two
 * listeners that carry the identical JSON protocol.
 *
 * The unix socket is the same-machine path and the single-Console lock; its
 * boundary is filesystem permissions, so a peer there is trusted on connect.
 * The network listener is the cross-machine path: it has no such boundary, so
 * a peer there proves itself with a pre-shared token and must keep beating or
 * lose its unmute holds. Both are first-class — the unix socket is not a
 * legacy path.
 */

import { timingSafeEqual } from "node:crypto";
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
import type { Server as BunServer } from "bun";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommand,
  type RemoteState,
} from "./remote-protocol.ts";

const MAX_BUFFER_BYTES = 8 * 1024;
/**
 * Meter cadence, not the latency floor: dB readings are continuous, so state
 * streams at this rate regardless. Discrete changes — mute, holds, phase —
 * call publish() directly and do not wait for the next tick.
 */
const PUBLISH_INTERVAL_MS = 100;
const SWEEP_INTERVAL_MS = 500;
/** A network peer unheard from for this long loses its unmute holds. */
export const DEFAULT_HEARTBEAT_DEADLINE_MS = 4_000;
/** A network peer that has not said hello by now never will. */
const HELLO_DEADLINE_MS = 2_000;
/** Transport-level backstop behind the heartbeat sweep. */
const WS_IDLE_TIMEOUT_SECONDS = 10;

export interface RemoteNetworkOptions {
  /** Address to bind. Never 0.0.0.0 — config resolution enforces the range. */
  host: string;
  port: number;
  token: string;
}

export interface ClientControlServerOptions {
  socketPath: string;
  /** Omitted leaves the Console reachable only from its own machine. */
  network?: RemoteNetworkOptions;
  state(): RemoteState;
  onCommand(command: RemoteCommand, peer: RemoteControlPeer): void;
  onPeerClose?(peer: RemoteControlPeer): void;
  heartbeatDeadlineMs?: number;
  now?: () => number;
}

export interface RemoteControlPeer {
  readonly id: number;
}

interface ControlPeer {
  readonly identity: RemoteControlPeer;
  /** Network peers authorize by token and are swept for liveness; unix peers are neither. */
  readonly network: boolean;
  authorized: boolean;
  lastSeen: number;
  send(frame: string): void;
  close(): void;
}

interface WebSocketPeerData {
  peer: ControlPeer | null;
}

export class ClientControlServer {
  private readonly peers = new Set<ControlPeer>();
  private readonly bySocket = new Map<Socket, ControlPeer>();
  private server: Server | null = null;
  private wsServer: BunServer<WebSocketPeerData> | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private identity: { dev: number; ino: number } | null = null;
  private nextPeerId = 1;
  private readonly now: () => number;
  private readonly heartbeatDeadlineMs: number;

  constructor(private readonly options: ClientControlServerOptions) {
    this.now = options.now ?? Date.now;
    this.heartbeatDeadlineMs = options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS;
  }

  async start(): Promise<void> {
    await this.startUnixListener();
    try {
      this.startNetworkListener();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.publishTimer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
    this.publishTimer.unref?.();
    // Sweeping no less often than twice per deadline keeps a stranded hold's
    // worst-case lifetime close to the deadline itself.
    const sweepMs = Math.max(
      20,
      Math.min(SWEEP_INTERVAL_MS, Math.floor(this.heartbeatDeadlineMs / 2)),
    );
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /** The address network Remote consoles dial, or null when none is served. */
  networkAddress(): string | null {
    const network = this.options.network;
    if (!network || !this.wsServer) return null;
    // The bound port, not the requested one: 0 means "any free port".
    return `${network.host}:${this.wsServer.port}`;
  }

  publish(): void {
    if (this.peers.size === 0) return;
    const frame = encodeRemoteMessage(this.options.state());
    for (const peer of this.peers) {
      if (peer.authorized) peer.send(frame);
    }
  }

  async close(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.publishTimer = null;
    this.sweepTimer = null;
    for (const peer of [...this.peers]) {
      this.dropPeer(peer);
      peer.close();
    }
    const wsServer = this.wsServer;
    this.wsServer = null;
    // Never awaited: on Bun 1.3.14 the promise from stop() never settles once
    // the server itself has closed a WebSocket — which is exactly what a
    // refusal or a missed heartbeat does. The listener stops accepting and the
    // port frees regardless (verified by rebinding it), and every peer was
    // force-closed above, so the unsettled promise costs nothing.
    void wsServer?.stop(true);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    removeOwnedSocket(this.options.socketPath, this.identity);
    this.identity = null;
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  private async startUnixListener(): Promise<void> {
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    // The lock serializes stale-cleanup-and-bind: without it, two consoles
    // racing after a crash can both classify the same inode stale, and the
    // second unlink removes the winner's freshly bound socket — leaving two
    // consoles sharing one orchestrator agent.
    const releaseLock = acquireStartLock(`${this.options.socketPath}.lock`);
    try {
      await removeStaleSocket(this.options.socketPath);
      const server = createServer((peer) => this.acceptSocket(peer));
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
    } finally {
      releaseLock();
    }
  }

  private startNetworkListener(): void {
    const network = this.options.network;
    if (!network) return;
    const expected = Buffer.from(network.token, "utf8");
    this.wsServer = Bun.serve<WebSocketPeerData, never>({
      hostname: network.host,
      port: network.port,
      fetch: (request, server) =>
        server.upgrade(request, { data: { peer: null } })
          ? undefined
          : new Response("agentvoice remote control: websocket only\n", { status: 426 }),
      websocket: {
        // Our own ping carries liveness; the idle timeout is the transport
        // backstop for a peer that vanishes without a FIN.
        sendPings: false,
        idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
        open: (ws) => {
          ws.data.peer = this.addPeer({
            network: true,
            send: (frame) => {
              ws.send(frame);
            },
            close: () => ws.close(),
          });
        },
        message: (ws, message) => {
          const peer = ws.data.peer;
          if (!peer) return;
          this.receive(peer, typeof message === "string" ? message : message.toString(), expected);
        },
        close: (ws) => {
          const peer = ws.data.peer;
          ws.data.peer = null;
          if (peer) this.dropPeer(peer);
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  private addPeer(spec: Pick<ControlPeer, "network" | "send" | "close">): ControlPeer {
    const peer: ControlPeer = {
      identity: Object.freeze({ id: this.nextPeerId++ }),
      network: spec.network,
      // The unix socket's boundary is already the filesystem; a network peer
      // stays unauthorized until its hello clears the token.
      authorized: !spec.network,
      lastSeen: this.now(),
      send: spec.send,
      close: spec.close,
    };
    this.peers.add(peer);
    if (peer.authorized) peer.send(encodeRemoteMessage(this.options.state()));
    return peer;
  }

  private acceptSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    const peer = this.addPeer({
      network: false,
      send: (frame) => {
        if (!socket.destroyed && !socket.writableNeedDrain) socket.write(frame);
      },
      close: () => socket.destroy(),
    });
    this.bySocket.set(socket, peer);
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_BUFFER_BYTES) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        this.receive(peer, line, null);
      }
    });
    const drop = () => {
      this.bySocket.delete(socket);
      this.dropPeer(peer);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  /** `expected` is the token for network peers, null for trusted unix peers. */
  private receive(peer: ControlPeer, line: string, expected: Buffer | null): void {
    peer.lastSeen = this.now();
    const command = parseRemoteCommand(line);
    if (!command) return;
    if (!peer.authorized) {
      if (command.type !== "hello" || expected === null) return;
      const reason = helloRefusal(command.protocol, command.token, expected);
      if (reason) {
        peer.send(encodeRemoteMessage({ type: "reject", reason }));
        peer.close();
        return;
      }
      peer.authorized = true;
      peer.send(encodeRemoteMessage(this.options.state()));
      return;
    }
    if (command.type === "hello" || command.type === "ping") return;
    this.options.onCommand(command, peer.identity);
  }

  /**
   * Releases the holds of a network peer that stopped beating. A dead Remote
   * console's TCP close can lag by minutes, and until it lands the Console
   * still believes a push-to-talk hold is open — a live microphone nobody is
   * holding.
   */
  private sweep(): void {
    const now = this.now();
    for (const peer of [...this.peers]) {
      if (!peer.network) continue;
      const deadline = peer.authorized ? this.heartbeatDeadlineMs : HELLO_DEADLINE_MS;
      if (now - peer.lastSeen <= deadline) continue;
      this.dropPeer(peer);
      peer.close();
    }
  }

  private dropPeer(peer: ControlPeer): void {
    if (!this.peers.delete(peer)) return;
    this.options.onPeerClose?.(peer.identity);
  }
}

/** Constant-time so a wrong token leaks nothing about the right one. */
function helloRefusal(protocol: number, token: string, expected: Buffer): string | null {
  if (protocol !== REMOTE_PROTOCOL_VERSION) {
    return `protocol ${protocol} does not match the Console's ${REMOTE_PROTOCOL_VERSION}; the Console and Remote console ship together — upgrade both`;
  }
  const offered = Buffer.from(token, "utf8");
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return "token rejected";
  }
  return null;
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
