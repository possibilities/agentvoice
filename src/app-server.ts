import type { Subprocess } from "bun";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AppServerError extends Error {
  readonly code?: number;
  readonly timedOut: boolean;

  constructor(message: string, code?: number, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  method: string;
  match(params: Record<string, unknown>): boolean;
  resolve(params: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerOptions {
  codexPath?: string;
  cwd: string;
  clientVersion: string;
  onNotification?(method: string, params: Record<string, unknown>): void;
  onProtocolMessage?(direction: "in" | "out", message: Record<string, unknown>): void;
  onStderr?(text: string): void;
}

/**
 * An isolated Codex App-server over its native newline-delimited stdio
 * transport. WebRTC carries voice media directly; this channel carries thread
 * lifecycle, signaling, transcripts, and orchestrator progress.
 */
export class AppServerClient {
  private readonly options: AppServerOptions;
  private readonly child: Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private nextRequestId = 1;
  private closed = false;
  private stdoutRemainder = "";
  private stderrRemainder = "";

  private constructor(options: AppServerOptions) {
    this.options = options;
    this.child = Bun.spawn(
      [options.codexPath ?? "codex", "app-server", "--enable", "realtime_conversation", "--stdio"],
      {
        cwd: options.cwd,
        env: appServerEnvironment(),
        // Give this ephemeral App-server (and every MCP child it starts) an
        // owned process group so teardown can reap the whole tree.
        detached: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    void this.readStdout();
    void this.readStderr();
    void this.child.exited.then((code) => this.finish(`App-server exited with code ${code}`));
  }

  static async start(options: AppServerOptions): Promise<AppServerClient> {
    const client = new AppServerClient(options);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "agentvoice-eval",
          title: "AgentVoice Eval",
          version: options.clientVersion,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AppServerError(`${method}: App-server is closed`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new AppServerError(
            `${method}: failed to write to App-server: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(
    method: string,
    match: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new AppServerError("App-server is closed"));
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(
            new AppServerError(`no ${method} notification within ${timeoutMs}ms`, undefined, true),
          );
        }, timeoutMs),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // The process may already have closed stdin.
    }
    const exited = await Promise.race([
      this.child.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (!exited) {
      this.terminateProcessGroup("SIGTERM");
      const terminated = await Promise.race([
        this.child.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      if (!terminated) this.terminateProcessGroup("SIGKILL");
    }
    this.terminateProcessGroup("SIGTERM");
    this.finish("App-server closed");
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) throw new AppServerError("App-server is closed");
    this.options.onProtocolMessage?.("out", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child.stdout) {
        this.stdoutRemainder += decoder.decode(chunk, { stream: true });
        this.drainStdoutLines();
      }
      this.stdoutRemainder += decoder.decode();
      this.drainStdoutLines(true);
    } catch (error) {
      this.finish(`failed reading App-server stdout: ${message(error)}`);
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child.stderr) {
        this.stderrRemainder += decoder.decode(chunk, { stream: true });
        this.drainStderrLines();
      }
      this.stderrRemainder += decoder.decode();
      this.drainStderrLines(true);
    } catch {
      // Process exit is surfaced through stdout/pending requests.
    }
  }

  private drainStdoutLines(flush = false): void {
    for (;;) {
      const newline = this.stdoutRemainder.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutRemainder.slice(0, newline).trim();
      this.stdoutRemainder = this.stdoutRemainder.slice(newline + 1);
      if (line) this.dispatchLine(line);
    }
    if (flush && this.stdoutRemainder.trim()) {
      this.dispatchLine(this.stdoutRemainder.trim());
      this.stdoutRemainder = "";
    }
  }

  private drainStderrLines(flush = false): void {
    for (;;) {
      const newline = this.stderrRemainder.indexOf("\n");
      if (newline < 0) break;
      const line = this.stderrRemainder.slice(0, newline + 1);
      this.stderrRemainder = this.stderrRemainder.slice(newline + 1);
      this.options.onStderr?.(line);
    }
    if (flush && this.stderrRemainder) {
      this.options.onStderr?.(this.stderrRemainder);
      this.stderrRemainder = "";
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onStderr?.(`[non-json stdout] ${line}\n`);
      return;
    }
    if (!isRecord(parsed)) return;
    this.options.onProtocolMessage?.("in", parsed);
    const id = parsed["id"];
    const method = parsed["method"];

    if (typeof id === "number" && method === undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = isRecord(parsed["error"]) ? parsed["error"] : null;
      if (error) {
        pending.reject(
          new AppServerError(
            `${pending.method}: ${typeof error["message"] === "string" ? error["message"] : "unknown App-server error"}`,
            typeof error["code"] === "number" ? error["code"] : undefined,
          ),
        );
      } else {
        pending.resolve(parsed["result"]);
      }
      return;
    }

    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      this.send({ jsonrpc: "2.0", id, result: denialResponse(method) });
      return;
    }

    if (typeof method !== "string") return;
    const params = isRecord(parsed["params"]) ? parsed["params"] : {};
    for (const waiter of this.notificationWaiters) {
      if (waiter.method !== method || !waiter.match(params)) continue;
      this.notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(params);
    }
    this.options.onNotification?.(method, params);
  }

  private finish(reason: string): void {
    this.terminateProcessGroup("SIGTERM");
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(`${pending.method}: ${reason}`));
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new AppServerError(reason));
    }
    this.notificationWaiters.clear();
  }

  private terminateProcessGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      // The owned process group is already gone.
    }
  }
}

function denialResponse(method: string): Record<string, unknown> {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "agentvoice eval never approves" } } };
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

function appServerEnvironment(): NodeJS.ProcessEnv {
  const env = environmentWithoutOpenAiApiKey();
  env["PYTHONDONTWRITEBYTECODE"] = "1";
  // The reference contender must use Codex subscription authentication, and
  // the coding workspace never needs access to the paid fixture-render key.
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
