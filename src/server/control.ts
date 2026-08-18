/**
 * The Server's control listeners: two transports carrying the identical JSON
 * protocol. The unix socket is the same-machine path and the single-Server
 * lock; its boundary is filesystem permissions. The network listener is the
 * cross-machine path: a peer there proves itself with a pre-shared token and
 * must keep beating or lose its unmute holds. Both are first-class.
 *
 * Every peer's first frame is a hello declaring its role. At most one voice
 * peer exists at a time — a newer voice hello supersedes the incumbent, which
 * is demoted to a ui peer and told to stand down. The Server holds no mute
 * truth: it routes commands to the voice peer and fans the voice peer's
 * published state out to ui peers.
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
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlRole,
  type ControlState,
  encodeControlFrame,
  type HelloCommand,
  parseControlCommand,
  type ServerFrame,
} from "../core/control-protocol.ts";

const MAX_BUFFER_BYTES = 64 * 1024;
/** A peer whose kernel-side reader wedges this far behind is dead weight. */
const MAX_WRITE_BACKLOG_BYTES = 512 * 1024;
/** A peer that has not said hello by now never will. */
const HELLO_DEADLINE_MS = 2_000;
/** A network peer unheard from for this long loses its unmute holds. */
export const DEFAULT_HEARTBEAT_DEADLINE_MS = 4_000;
const SWEEP_INTERVAL_MS = 500;
/** Transport-level backstop behind the heartbeat sweep. */
const WS_IDLE_TIMEOUT_SECONDS = 10;

export interface ControlNetworkOptions {
  /** Address to bind. Never 0.0.0.0 — config resolution enforces the range. */
  host: string;
  port: number;
  token: string;
}

export interface ControlPeerHandle {
  readonly id: number;
  readonly role: ControlRole;
}

export interface ControlServerOptions {
  socketPath: string;
  /** Omitted leaves the Server reachable only from its own machine. */
  network?: ControlNetworkOptions;
  state(): ControlState;
  /** Dispatched for every authorized command except hello and ping. */
  onCommand(command: ControlCommand, peer: ControlPeerHandle): void;
  /** A ui peer (including a demoted voice peer) detached. */
  onPeerClose?(peer: ControlPeerHandle): void;
  onVoicePeerAttached?(peer: ControlPeerHandle): void;
  onVoicePeerGone?(): void;
  heartbeatDeadlineMs?: number;
  now?: () => number;
}

interface ControlPeer {
  readonly id: number;
  /** Network peers authorize by token and are swept for liveness. */
  readonly network: boolean;
  /** null until the hello lands; commands before it are dropped. */
  role: ControlRole | null;
  readonly handle: ControlPeerHandle;
  lastSeen: number;
  /** droppable: skip under backpressure (the state stream tolerates gaps). */
  send(frame: string, droppable: boolean): void;
  close(): void;
}

interface WebSocketPeerData {
  peer: ControlPeer | null;
}

export class ControlServer {
  private readonly peers = new Set<ControlPeer>();
  private voice: ControlPeer | null = null;
  private server: Server | null = null;
  private wsServer: BunServer<WebSocketPeerData> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private identity: { dev: number; ino: number } | null = null;
  private nextPeerId = 1;
  private readonly now: () => number;
  private readonly heartbeatDeadlineMs: number;

  constructor(private readonly options: ControlServerOptions) {
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
    const sweepMs = Math.max(
      20,
      Math.min(SWEEP_INTERVAL_MS, Math.floor(this.heartbeatDeadlineMs / 2)),
    );
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /** The address network peers dial, or null when none is served. */
  networkAddress(): string | null {
    const network = this.options.network;
    if (!network || !this.wsServer) return null;
    // The bound port, not the requested one: 0 means "any free port".
    return `${network.host}:${this.wsServer.port}`;
  }

  /** Fan the current state out to ui peers; the voice peer already knows. */
  publish(): void {
    let frame: string | null = null;
    for (const peer of this.peers) {
      if (peer.role !== "ui") continue;
      frame ??= encodeControlFrame(this.options.state());
      peer.send(frame, true);
    }
  }

  hasVoicePeer(): boolean {
    return this.voice !== null;
  }

  /** Reliable delivery to the voice peer; false when none is attached. */
  sendToVoicePeer(frame: ServerFrame): boolean {
    const voice = this.voice;
    if (!voice) return false;
    voice.send(encodeControlFrame(frame), false);
    return true;
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
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
    // port frees regardless, and every peer was force-closed above.
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
    // The lock serializes stale-cleanup-and-bind: without it, two servers
    // racing after a crash can both classify the same inode stale, and the
    // second unlink removes the winner's freshly bound socket.
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
        throw new Error("control socket permissions are unsafe");
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
          : new Response("agentvoice control: websocket only\n", { status: 426 }),
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

  private addPeer(spec: {
    network: boolean;
    send(frame: string): void;
    close(): void;
  }): ControlPeer {
    const id = this.nextPeerId++;
    const peer: ControlPeer = {
      id,
      network: spec.network,
      role: null,
      // Role reads live through the getter so a demotion is visible to every
      // handle already handed out.
      handle: {
        id,
        get role() {
          return peer.role ?? "ui";
        },
      },
      lastSeen: this.now(),
      send: (frame) => spec.send(frame),
      close: spec.close,
    };
    this.peers.add(peer);
    return peer;
  }

  private acceptSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    const peer = this.addPeer({
      network: false,
      send: () => {},
      close: () => socket.destroy(),
    });
    // Unix sends distinguish droppable state (skipped under backpressure)
    // from session-critical frames, which node buffers; a reader wedged past
    // the backlog cap is destroyed rather than buffered forever.
    peer.send = (frame, droppable) => {
      if (socket.destroyed) return;
      if (droppable && socket.writableNeedDrain) return;
      if (socket.writableLength > MAX_WRITE_BACKLOG_BYTES) {
        socket.destroy();
        return;
      }
      socket.write(frame);
    };
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
    const drop = () => this.dropPeer(peer);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  /** `expected` is the token for network peers, null for trusted unix peers. */
  private receive(peer: ControlPeer, line: string, expected: Buffer | null): void {
    peer.lastSeen = this.now();
    const command = parseControlCommand(line);
    if (!command) return;
    if (peer.role === null) {
      if (command.type !== "hello") return;
      const reason = helloRefusal(command, expected);
      if (reason) {
        peer.send(encodeControlFrame({ type: "reject", reason }), false);
        peer.close();
        return;
      }
      this.admit(peer, command.role);
      return;
    }
    if (command.type === "hello" || command.type === "ping") return;
    // Voice frames only from the voice peer; a demoted peer's late frames drop.
    if ((command.type === "offer" || command.type === "voice-state") && peer.role !== "voice") {
      return;
    }
    this.options.onCommand(command, peer.handle);
  }

  private admit(peer: ControlPeer, role: ControlRole): void {
    if (role === "voice") {
      const incumbent = this.voice;
      if (incumbent) {
        incumbent.role = "ui";
        incumbent.send(encodeControlFrame({ type: "voice-superseded" }), false);
        incumbent.send(encodeControlFrame(this.options.state()), false);
      }
      peer.role = "voice";
      this.voice = peer;
      this.options.onVoicePeerAttached?.(peer.handle);
      return;
    }
    peer.role = "ui";
    peer.send(encodeControlFrame(this.options.state()), false);
  }

  /**
   * Releases what a vanished peer held. A dead network peer's TCP close can
   * lag by minutes, and until it lands the voice peer still believes a
   * push-to-talk hold is open — a live microphone nobody is holding. Peers
   * of either transport that never say hello are dropped on the same sweep.
   */
  private sweep(): void {
    const now = this.now();
    for (const peer of [...this.peers]) {
      const deadline =
        peer.role === null ? HELLO_DEADLINE_MS : peer.network ? this.heartbeatDeadlineMs : null;
      if (deadline === null || now - peer.lastSeen <= deadline) continue;
      this.dropPeer(peer);
      peer.close();
    }
  }

  private dropPeer(peer: ControlPeer): void {
    if (!this.peers.delete(peer)) return;
    if (this.voice === peer) {
      this.voice = null;
      this.options.onVoicePeerGone?.();
      return;
    }
    if (peer.role !== null) this.options.onPeerClose?.(peer.handle);
  }
}

/** Constant-time so a wrong token leaks nothing about the right one. */
function helloRefusal(hello: HelloCommand, expected: Buffer | null): string | null {
  if (hello.protocol !== CONTROL_PROTOCOL_VERSION) {
    return `protocol ${hello.protocol} does not match the Server's ${CONTROL_PROTOCOL_VERSION}; the Server and its consoles ship together — upgrade both`;
  }
  if (expected === null) return null;
  const offered = Buffer.from(hello.token ?? "", "utf8");
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
        throw new Error(`another AgentVoice server is starting (start lock held by pid ${holder})`);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // raced another lock breaker; the retry decides
      }
    }
  }
  throw new Error("could not acquire the server start lock");
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
    throw new Error(`refusing unsafe existing control socket: ${path}`);
  }
  const active = await socketAcceptsConnections(path);
  if (active) throw new Error("another AgentVoice server already owns the control socket");
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isSocket()) {
    throw new Error("control socket changed during stale cleanup");
  }
  unlinkSync(path);
}

export function socketAcceptsConnections(path: string): Promise<boolean> {
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
