/**
 * Supervised Codex App-server plus AgentVoice's owning connection.
 *
 * The child listens on a private Unix socket. AgentVoice and every gateway
 * peer connect independently, preserving App-server's native connection-scoped
 * initialization, subscriptions, approvals, and disconnect cleanup.
 */
import type { Subprocess } from "bun";
import { UnixWebSocket } from "./unix-websocket.ts";

export const REALTIME_FEATURE = "realtime_conversation";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 100;
const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 25;

export class AppServerError extends Error {
  readonly code?: number;
  readonly timedOut: boolean;
  constructor(message: string, code?: number, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

export interface ParsedFrames {
  frames: unknown[];
  rest: string;
}

export function parseFrames(buffer: string): ParsedFrames {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      frames.push(JSON.parse(trimmed));
    } catch {
      // Compatibility helper for newline transports and fixtures.
    }
  }
  return { frames, rest };
}

export function frameRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export function frameNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

export function frameResponse(id: number | string, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

export function buildDenialResponse(method: string): Record<string, unknown> {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: { denied: { rejection: "agentvoice runs unattended and never approves" } },
      };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
    case "tool/requestUserInput":
      return { answers: {} };
    default:
      return {};
  }
}

export function spawnArgv(codexBin: string, socketPath?: string): string[] {
  return [
    codexBin,
    "app-server",
    "--enable",
    REALTIME_FEATURE,
    "--listen",
    socketPath === undefined ? "stdio://" : `unix://${socketPath}`,
  ];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface AppServerConnectionOptions {
  socketPath: string;
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null;
  onClose?(): void;
  onFrame?(
    direction: "toAppServer" | "fromAppServer",
    owner: "agentvoice" | "appServer",
    frame: Record<string, unknown>,
  ): void;
  debug?(line: string): void;
}

/** One real App-server connection and its own request-id namespace. */
export class AppServerConnection {
  private readonly options: AppServerConnectionOptions;
  private socket: UnixWebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stopping = false;

  constructor(options: AppServerConnectionOptions) {
    this.options = options;
  }

  get alive(): boolean {
    return this.socket?.isOpen === true;
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const socket = new UnixWebSocket({
      socketPath: this.options.socketPath,
      onText: (text) => this.dispatchText(text),
      onClose: () => this.handleClose(),
      onError: (error) => this.options.debug?.(`[app-server connection] ${error.message}`),
    });
    this.socket = socket;
    try {
      await socket.connect(timeoutMs);
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      throw new AppServerError(
        `failed to connect to app-server socket ${this.options.socketPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new AppServerError(`${method}: app-server is not connected`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new AppServerError(
            `${method}: failed to write to app-server: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.socket?.close(1000, "connection closed");
    this.socket = null;
    this.rejectPending("app-server connection closed before responding");
  }

  private writeMessage(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket?.isOpen) throw new AppServerError("app-server is not connected");
    const text = JSON.stringify(message);
    this.options.debug?.(`-> ${text}`);
    socket.sendText(text);
    this.emitFrame("toAppServer", "agentvoice", message);
  }

  private dispatchText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.options.debug?.("[app-server connection] dropped non-JSON WebSocket message");
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const message = frame as Record<string, unknown>;
    this.options.debug?.(`<- ${JSON.stringify(message)}`);
    const { id, method } = message;
    const pending =
      typeof id === "number" && method === undefined ? this.pending.get(id) : undefined;
    this.emitFrame("fromAppServer", pending ? "agentvoice" : "appServer", message);

    if (typeof id === "number" && method === undefined) {
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message["error"] as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new AppServerError(
            `${pending.method}: ${error.message ?? "unknown app-server error"}`,
            error.code,
          ),
        );
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }

    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      const requestId = id;
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      const handled = this.options.onRequest?.(method, params);
      if (handled) {
        handled
          .then((response) =>
            this.writeMessage({
              jsonrpc: "2.0",
              id: requestId,
              result: response ?? buildDenialResponse(method),
            }),
          )
          .catch(() =>
            this.writeMessage({
              jsonrpc: "2.0",
              id: requestId,
              result: buildDenialResponse(method),
            }),
          );
      } else {
        this.writeMessage({
          jsonrpc: "2.0",
          id: requestId,
          result: buildDenialResponse(method),
        });
      }
      return;
    }

    if (typeof method === "string") {
      this.options.onNotification(method, (message["params"] ?? {}) as Record<string, unknown>);
    }
  }

  private emitFrame(
    direction: "toAppServer" | "fromAppServer",
    owner: "agentvoice" | "appServer",
    message: Record<string, unknown>,
  ): void {
    try {
      this.options.onFrame?.(direction, owner, message);
    } catch (error) {
      this.options.debug?.(
        `[app-server frame observer] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.rejectPending("app-server connection closed before responding");
    if (!this.stopping) this.options.onClose?.();
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(`${pending.method}: ${message}`));
    }
    this.pending.clear();
  }
}

export interface AppServerOptions {
  codexBin: string;
  processCwd: string;
  socketPath: string;
  codexHome?: string;
  clientVersion: string;
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null;
  onExit(info: { code: number | null; expected: boolean }): void;
  onFrame?(
    direction: "toAppServer" | "fromAppServer",
    owner: "agentvoice" | "appServer",
    frame: Record<string, unknown>,
  ): void;
  debug?(line: string): void;
}

export class AppServer {
  private readonly options: AppServerOptions;
  private child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private connection: AppServerConnection | null = null;
  private readonly stderrTail: string[] = [];
  private stopping = false;
  readonly spawnedAt = Date.now();

  constructor(options: AppServerOptions) {
    this.options = options;
  }

  get alive(): boolean {
    return this.child !== null && this.connection?.alive === true;
  }

  get recentStderr(): string {
    return this.stderrTail.slice(-8).join("\n");
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(spawnArgv(this.options.codexBin, this.options.socketPath), {
        cwd: this.options.processCwd,
        ...(this.options.codexHome !== undefined
          ? { env: { ...process.env, CODEX_HOME: this.options.codexHome } }
          : {}),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new AppServerError(
        `failed to spawn "${this.options.codexBin}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.child = child;
    const killGuard = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    process.on("exit", killGuard);
    void child.exited.then((code) => {
      process.off("exit", killGuard);
      this.handleExit(code);
    });
    void this.pumpOutput(child.stdout, false);
    void this.pumpOutput(child.stderr, true);

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline && this.child === child) {
      const connection = new AppServerConnection({
        socketPath: this.options.socketPath,
        onNotification: this.options.onNotification,
        ...(this.options.onRequest ? { onRequest: this.options.onRequest } : {}),
        onFrame: this.options.onFrame,
        onClose: () => {
          if (!this.stopping && this.child === child) child.kill("SIGTERM");
        },
        debug: this.options.debug,
      });
      try {
        await connection.connect(Math.min(500, Math.max(1, deadline - Date.now())));
        this.connection = connection;
        await connection.request("initialize", {
          clientInfo: {
            name: "agentvoice",
            title: "AgentVoice",
            version: this.options.clientVersion,
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        connection.notify("initialized", {});
        return;
      } catch (error) {
        lastError = error;
        connection.close();
        if (this.child !== child) break;
        await Bun.sleep(CONNECT_RETRY_MS);
      }
    }
    throw new AppServerError(
      `app-server socket did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const connection = this.connection;
    if (!connection) {
      return Promise.reject(new AppServerError(`${method}: app-server is not running`));
    }
    return connection.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): void {
    const connection = this.connection;
    if (!connection) throw new AppServerError("app-server is not running");
    connection.notify(method, params);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.connection?.close();
    this.connection = null;
    child.kill("SIGTERM");
    if ((await this.waitForExit(child, 2_000)) !== null) return;
    child.kill("SIGKILL");
    await child.exited;
  }

  private async waitForExit(
    child: Subprocess<"ignore", "pipe", "pipe">,
    timeoutMs: number,
  ): Promise<number | null> {
    return Promise.race([
      child.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  private async pumpOutput(stream: ReadableStream<Uint8Array>, stderr: boolean): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          if (stderr) {
            this.stderrTail.push(line);
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
          }
          this.options.debug?.(`[app-server ${stderr ? "stderr" : "stdout"}] ${line}`);
        }
      }
    } catch {
      // Child exit owns lifecycle cleanup.
    }
  }

  private handleExit(code: number | null): void {
    const expected = this.stopping;
    this.child = null;
    this.connection?.close();
    this.connection = null;
    this.options.onExit({ code, expected });
  }
}
