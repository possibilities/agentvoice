import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import {
  dispatchControl,
  errorResponse,
  type SocketResponse,
  socketRequestSchema,
} from "./contract.ts";
import { CONTROL_PROTOCOL_VERSION, type ControlBackend, ControlError } from "./types.ts";

const MAX_FRAME_BYTES = 1 << 20;
const MAX_PENDING = 128;
const MAX_OUTGOING_BYTES = 4 * 1024 * 1024;

type State = {
  id: number;
  partial: string;
  decoder: TextDecoder;
  pending: number;
  outgoing: Uint8Array[];
  outgoingBytes: number;
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = statSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error(`control directory is not private: ${path}`);
  chmodSync(path, 0o700);
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    void Bun.connect({
      unix: path,
      socket: {
        open: (peer) => {
          peer.end();
        },
        error: () => resolve(false),
        close: () => resolve(true),
      },
    }).catch(() => resolve(false));
  });
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** An atomic, stale-aware local ownership guard for probe/unlink/bind. */
class SocketOwner {
  private readonly path: string;
  private held = false;

  constructor(socketPath: string) {
    this.path = `${socketPath}.lock`;
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${process.pid}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number.parseInt(readFileSync(this.path, "utf8"), 10);
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
            throw new Error(`another AgentVoice controller owns ${this.path}`);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
          }
        }
        removeIfPresent(this.path);
      }
    }
    throw new Error(`could not acquire control socket ownership for ${this.path}`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    removeIfPresent(this.path);
  }
}

/** Private, bounded NDJSON control socket. It shares dispatchControl with MCP. */
export class ControlSocketServer {
  private server: ReturnType<typeof Bun.listen<State>> | null = null;
  private readonly clients = new Map<number, Socket<State>>();
  private nextId = 1;
  private readonly owner: SocketOwner;

  constructor(
    readonly path: string,
    private readonly backend: ControlBackend,
  ) {
    this.owner = new SocketOwner(path);
  }

  async start(): Promise<void> {
    if (this.server) return;
    privateDirectory(dirname(this.path));
    this.owner.acquire();
    try {
      if (existsSync(this.path) && (await socketAnswers(this.path)))
        throw new Error(`another AgentVoice controller answers at ${this.path}`);
      removeIfPresent(this.path);
      this.server = Bun.listen<State>({
        unix: this.path,
        socket: {
          open: (socket) => this.open(socket),
          data: (socket, data) => this.data(socket, data),
          drain: (socket) => this.flush(socket),
          close: (socket) => this.forget(socket),
          error: (socket) => this.forget(socket),
        },
      });
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.server?.stop(true);
      this.server = null;
      removeIfPresent(this.path);
      this.owner.release();
      throw error;
    }
  }

  close(): void {
    this.server?.stop(true);
    this.server = null;
    for (const socket of this.clients.values()) socket.terminate();
    this.clients.clear();
    removeIfPresent(this.path);
    this.owner.release();
  }

  private open(socket: Socket<State>): void {
    const state: State = {
      id: this.nextId++,
      partial: "",
      decoder: new TextDecoder(),
      pending: 0,
      outgoing: [],
      outgoingBytes: 0,
    };
    socket.data = state;
    this.clients.set(state.id, socket);
  }

  private forget(socket: Socket<State>): void {
    socket.data.partial = "";
    socket.data.outgoing = [];
    socket.data.outgoingBytes = 0;
    this.clients.delete(socket.data.id);
  }

  private data(socket: Socket<State>, chunk: Buffer): void {
    const state = socket.data;
    state.partial += state.decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(state.partial) > MAX_FRAME_BYTES && !state.partial.includes("\n")) {
      this.send(
        socket,
        errorResponse(null, new ControlError("invalid_request", "frame exceeds 1 MiB")),
      );
      socket.end();
      return;
    }
    for (;;) {
      const index = state.partial.indexOf("\n");
      if (index < 0) return;
      const line = state.partial.slice(0, index).trim();
      state.partial = state.partial.slice(index + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.send(
          socket,
          errorResponse(null, new ControlError("invalid_request", "frame exceeds 1 MiB")),
        );
        socket.end();
        return;
      }
      if (state.pending >= MAX_PENDING) {
        socket.terminate();
        this.forget(socket);
        return;
      }
      state.pending += 1;
      void this.handle(socket, line).finally(() => {
        state.pending -= 1;
      });
    }
  }

  private async handle(socket: Socket<State>, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.send(
        socket,
        errorResponse(
          null,
          new ControlError("invalid_request", "expected one JSON object per line"),
        ),
      );
      return;
    }
    const checked = socketRequestSchema.safeParse(parsed);
    if (!checked.success) {
      const id =
        typeof (parsed as { id?: unknown })?.id === "string" ? (parsed as { id: string }).id : null;
      this.send(
        socket,
        errorResponse(id, new ControlError("invalid_request", "invalid control request")),
      );
      return;
    }
    try {
      const result = await dispatchControl(this.backend, checked.data.method, checked.data.params);
      this.send(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "response",
        id: checked.data.id,
        ok: true,
        result,
      });
    } catch (error) {
      this.send(socket, errorResponse(checked.data.id, error));
    }
  }

  private send(socket: Socket<State>, response: SocketResponse): void {
    const state = socket.data;
    if (!this.clients.has(state.id)) return;
    const data = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
    if (state.outgoingBytes + data.byteLength > MAX_OUTGOING_BYTES) {
      socket.terminate();
      this.forget(socket);
      return;
    }
    state.outgoing.push(data);
    state.outgoingBytes += data.byteLength;
    this.flush(socket);
  }

  private flush(socket: Socket<State>): void {
    const state = socket.data;
    while (state.outgoing.length) {
      const data = state.outgoing[0]!;
      let written: number;
      try {
        written = socket.write(data);
      } catch {
        socket.terminate();
        this.forget(socket);
        return;
      }
      if (written < 0) {
        socket.terminate();
        this.forget(socket);
        return;
      }
      state.outgoingBytes -= written;
      if (written < data.byteLength) {
        state.outgoing[0] = data.subarray(written);
        return;
      }
      state.outgoing.shift();
    }
  }
}

export function controlSocketPath(stateDir: string, instanceId: string): string {
  const safe = Bun.hash(instanceId).toString(16);
  return join(stateDir, "control", `${safe}.sock`);
}
