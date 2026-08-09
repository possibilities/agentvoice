/**
 * Newline-delimited JSON-RPC 2.0 client for a `codex app-server` child process.
 *
 * Three gates make the realtime surface work at all: the child must be spawned
 * with `--enable realtime_conversation`, `initialize` must declare
 * `experimentalApi: true`, and `thread/realtime/start` must carry an explicit
 * webrtc transport. Verified against codex-cli 0.147.0.
 */
import type { Subprocess } from "bun";

export const REALTIME_FEATURE = "realtime_conversation";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 100;

export class AppServerError extends Error {
  readonly code?: number;
  readonly timedOut: boolean;
  constructor(message: string, code?: number, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

// ---------------------------------------------------------------------------
// Pure framing helpers
// ---------------------------------------------------------------------------

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
      // app-server occasionally logs non-JSON lines to stdout; drop them.
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

/**
 * Fail-closed answers for approval-bearing server→client requests. The server
 * runs unattended, so an unanswered request would park the agent turn forever;
 * every request gets an immediate denial (or `{}` when the method is unknown).
 */
export function buildDenialResponse(method: string): Record<string, unknown> {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: {
          denied: { rejection: "agentvoice runs unattended and never approves" },
        },
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

export function spawnArgv(codexBin: string): string[] {
  return [codexBin, "app-server", "--enable", REALTIME_FEATURE, "--listen", "stdio://"];
}

// ---------------------------------------------------------------------------
// Child process client
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface AppServerOptions {
  codexBin: string;
  /**
   * Directory the child process runs in. app-server re-reads its own process
   * cwd on every thread/start; if that directory is unlinked mid-run, thread
   * starts fail with a cryptic config-load error, so this must be a stable
   * directory that outlives the child.
   */
  processCwd: string;
  clientVersion: string;
  onNotification(method: string, params: Record<string, unknown>): void;
  /**
   * Optional answerer for server→client requests. Return a promise resolving
   * to the response payload, or null (or reject) to fall back to the
   * fail-closed denial. Absent means every request is denied.
   */
  onRequest?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null;
  /** Called once when the child exits, after all pending requests were rejected. */
  onExit(info: { code: number | null; expected: boolean }): void;
  debug?(line: string): void;
}

export class AppServer {
  private readonly options: AppServerOptions;
  private child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private readonly stderrTail: string[] = [];
  private stopping = false;
  readonly spawnedAt = Date.now();

  constructor(options: AppServerOptions) {
    this.options = options;
  }

  get alive(): boolean {
    return this.child !== null;
  }

  get recentStderr(): string {
    return this.stderrTail.slice(-8).join("\n");
  }

  async start(): Promise<void> {
    let child: Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn(spawnArgv(this.options.codexBin), {
        cwd: this.options.processCwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new AppServerError(
        `failed to spawn "${this.options.codexBin}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.child = child;

    // The child must not outlive the parent even on an abrupt exit.
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

    void this.pumpStdout(child.stdout);
    void this.pumpStderr(child.stderr);

    await this.request("initialize", {
      clientInfo: {
        name: "agentvoice",
        title: "AgentVoice",
        version: this.options.clientVersion,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.child) {
      return Promise.reject(new AppServerError(`${method}: app-server is not running`));
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
        this.write(frameRequest(id, method, params));
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
    this.write(frameNotification(method, params));
  }

  /** Bounded teardown: stdin EOF, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed
    }
    if ((await this.waitForExit(child, 3_000)) !== null) return;
    child.kill("SIGTERM");
    if ((await this.waitForExit(child, 2_000)) !== null) return;
    child.kill("SIGKILL");
    await child.exited;
  }

  private async waitForExit(
    child: Subprocess<"pipe", "pipe", "pipe">,
    timeoutMs: number,
  ): Promise<number | null> {
    return Promise.race([
      child.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  private write(text: string): void {
    const child = this.child;
    if (!child) throw new AppServerError("app-server is not running");
    this.options.debug?.(`-> ${text.trimEnd()}`);
    child.stdin.write(text);
    child.stdin.flush();
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.stdoutBuffer += decoder.decode(chunk, { stream: true });
        const { frames, rest } = parseFrames(this.stdoutBuffer);
        this.stdoutBuffer = rest;
        for (const frame of frames) this.dispatch(frame);
      }
    } catch {
      // The stream ends when the child exits; handleExit owns cleanup.
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
          this.options.debug?.(`[app-server stderr] ${line}`);
        }
      }
    } catch {
      // ignore; child exit handles the rest
    }
  }

  private dispatch(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;
    this.options.debug?.(`<- ${JSON.stringify(message)}`);
    const { id, method } = message;

    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
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

    if (id !== undefined && typeof method === "string") {
      // Server→client request. A handler may answer it (dispatch tool calls);
      // everything else — and a handler that declines or throws — fail-closes
      // with an immediate denial so no request ever parks a turn.
      const requestId = id as number | string;
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      const handled = this.options.onRequest?.(method, params);
      if (handled) {
        handled
          .then((response) => {
            this.write(frameResponse(requestId, response ?? buildDenialResponse(method)));
          })
          .catch(() => {
            this.write(frameResponse(requestId, buildDenialResponse(method)));
          });
      } else {
        this.write(frameResponse(requestId, buildDenialResponse(method)));
      }
      return;
    }

    if (typeof method === "string") {
      this.options.onNotification(method, (message["params"] ?? {}) as Record<string, unknown>);
    }
  }

  private handleExit(code: number | null): void {
    const expected = this.stopping;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(`${pending.method}: app-server exited before responding`));
    }
    this.pending.clear();
    this.options.onExit({ code, expected });
  }
}
