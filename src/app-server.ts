import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CHILD_OBSERVATION_INTERVAL_MS = 100;
export const NATIVE_SIDECAR_SANDBOX_PROFILE = "(version 1)\n(allow default)\n(deny process-fork)\n";

export type AppServerExecutionProfile = "legacy-app-server" | "native-voice-sidecar";
export type ChildProcessPolicy = "owned-process-group" | "kernel-deny-fork" | "unavailable";

export interface AppServerIsolationEvidence {
  implementationProfile: AppServerExecutionProfile;
  platform: NodeJS.Platform;
  childProcessPolicy: ChildProcessPolicy;
  sandboxExecutable: string | null;
  sandboxProfileSha256: string | null;
  childObservation: "ps-descendant-sampling" | "not-required";
  childObservationErrorCount: number;
  observedChildProcessCount: number;
}

export type AppServerIsolationEvent =
  | "started"
  | "child-observed"
  | "observation-error"
  | "completed";

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
  /** Complete process argv for a standalone App Server build. */
  command?: readonly string[];
  executionProfile?: AppServerExecutionProfile;
  cwd: string;
  clientVersion: string;
  onNotification?(method: string, params: Record<string, unknown>): void;
  onProtocolMessage?(direction: "in" | "out", message: Record<string, unknown>): void;
  onIsolationEvent?(event: AppServerIsolationEvent, evidence: AppServerIsolationEvidence): void;
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
  private readonly isolation: AppServerIsolationEvidence;
  private readonly observedChildProcessIds = new Set<number>();
  private readonly stdoutDone: Promise<void>;
  private readonly stderrDone: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private nextRequestId = 1;
  private closed = false;
  private stdoutRemainder = "";
  private stderrRemainder = "";
  private childObservationTimer: ReturnType<typeof setInterval> | null = null;
  private childObservationTail: Promise<void> = Promise.resolve();
  private isolationCompletion: Promise<void> | null = null;

  private constructor(options: AppServerOptions) {
    this.options = options;
    const launch = appServerLaunch(options);
    this.isolation = launch.isolation;
    this.child = Bun.spawn(launch.command, {
      cwd: options.cwd,
      env: appServerEnvironment(),
      // Give this ephemeral App-server (and every MCP child it starts) an
      // owned process group so teardown can reap the whole tree.
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.options.onIsolationEvent?.("started", this.isolationEvidence());
    if (this.isolation.implementationProfile === "native-voice-sidecar") {
      this.queueChildObservation();
      this.childObservationTimer = setInterval(
        () => this.queueChildObservation(),
        CHILD_OBSERVATION_INTERVAL_MS,
      );
      this.childObservationTimer.unref?.();
    }
    this.stdoutDone = this.readStdout();
    this.stderrDone = this.readStderr();
    void this.child.exited.then(async (code) => {
      await Promise.allSettled([this.stdoutDone, this.stderrDone]);
      await this.completeIsolationEvidence();
      this.finish(`App-server exited with code ${code}`);
    });
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
      if (!terminated) {
        this.terminateProcessGroup("SIGKILL");
        await this.child.exited.catch(() => {});
      }
    }
    this.terminateProcessGroup("SIGTERM");
    await Promise.allSettled([this.stdoutDone, this.stderrDone]);
    await this.completeIsolationEvidence();
    this.finish("App-server closed");
  }

  isolationEvidence(): AppServerIsolationEvidence {
    return { ...this.isolation };
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

  private queueChildObservation(): void {
    this.childObservationTail = this.childObservationTail.then(() => this.observeChildren());
  }

  private async observeChildren(): Promise<void> {
    try {
      const ps = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid="], {
        env: appServerEnvironment(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
      if (exitCode !== 0) throw new Error(`/bin/ps exited with code ${exitCode}`);
      for (const pid of descendantProcessIds(stdout, this.child.pid)) {
        if (this.observedChildProcessIds.has(pid)) continue;
        this.observedChildProcessIds.add(pid);
        this.isolation.observedChildProcessCount = this.observedChildProcessIds.size;
        this.options.onIsolationEvent?.("child-observed", this.isolationEvidence());
      }
    } catch {
      this.isolation.childObservationErrorCount++;
      this.options.onIsolationEvent?.("observation-error", this.isolationEvidence());
    }
  }

  private completeIsolationEvidence(): Promise<void> {
    if (this.isolationCompletion) return this.isolationCompletion;
    this.isolationCompletion = (async () => {
      if (this.childObservationTimer) {
        clearInterval(this.childObservationTimer);
        this.childObservationTimer = null;
      }
      await this.childObservationTail;
      this.options.onIsolationEvent?.("completed", this.isolationEvidence());
    })();
    return this.isolationCompletion;
  }

  private terminateProcessGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      // The owned process group is already gone.
    }
  }
}

export function appServerCommand(
  options: Pick<AppServerOptions, "codexPath" | "command">,
): string[] {
  if (options.command) {
    if (options.command.length === 0) throw new Error("App-server command cannot be empty");
    return [...options.command];
  }
  return [
    options.codexPath ?? "codex",
    "app-server",
    "--enable",
    "realtime_conversation",
    "--stdio",
  ];
}

export function appServerLaunchCommand(
  options: Pick<AppServerOptions, "codexPath" | "command" | "executionProfile">,
  sandboxExecutable = nativeSandboxExecutable(),
): string[] {
  const command = appServerCommand(options);
  if (options.executionProfile !== "native-voice-sidecar") {
    return command;
  }
  if (sandboxExecutable === null) {
    throw new Error("native voice sidecar requires /usr/bin/sandbox-exec no-fork isolation");
  }
  return [sandboxExecutable, "-p", NATIVE_SIDECAR_SANDBOX_PROFILE, ...command];
}

function appServerLaunch(
  options: Pick<AppServerOptions, "codexPath" | "command" | "executionProfile">,
): { command: string[]; isolation: AppServerIsolationEvidence } {
  const executionProfile = options.executionProfile ?? "legacy-app-server";
  const sandboxExecutable =
    executionProfile === "native-voice-sidecar" ? nativeSandboxExecutable() : null;
  return {
    command: appServerLaunchCommand(options, sandboxExecutable),
    isolation: {
      implementationProfile: executionProfile,
      platform: process.platform,
      childProcessPolicy:
        executionProfile === "legacy-app-server"
          ? "owned-process-group"
          : sandboxExecutable
            ? "kernel-deny-fork"
            : "unavailable",
      sandboxExecutable,
      sandboxProfileSha256: sandboxExecutable
        ? createHash("sha256").update(NATIVE_SIDECAR_SANDBOX_PROFILE).digest("hex")
        : null,
      childObservation:
        executionProfile === "native-voice-sidecar" ? "ps-descendant-sampling" : "not-required",
      childObservationErrorCount: 0,
      observedChildProcessCount: 0,
    },
  };
}

function nativeSandboxExecutable(): string | null {
  const path = "/usr/bin/sandbox-exec";
  return process.platform === "darwin" && existsSync(path) ? path : null;
}

export function descendantProcessIds(psOutput: string, rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants.sort((left, right) => left - right);
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
