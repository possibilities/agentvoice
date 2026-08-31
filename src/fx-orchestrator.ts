import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";

const MAX_CONTROL_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ADE_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 4_000;
const GRACEFUL_STOP_TIMEOUT_MS = 1_500;
const TERMINATE_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 2_000;

const workSnapshotSchema = z.object({
  active_turn_id: z.string().nullable(),
  queue_paused: z.boolean(),
  queue: z.array(
    z.object({
      turn_id: z.string(),
      kind: z.enum(["queued", "steering"]),
      text: z.string(),
      has_images: z.boolean(),
      has_skill_bindings: z.boolean(),
      has_review_draft: z.boolean(),
    }),
  ),
});

const workControlResponseSchema = z.object({
  schema: z.literal(1),
  request_id: z.string().nullable(),
  instance_id: z.string(),
  ok: z.boolean(),
  result: z
    .object({
      turn_id: z.string().optional(),
      disposition: z.enum(["queued", "steering"]).optional(),
      snapshot: workSnapshotSchema,
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

const adeEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  event: z.string().min(1),
  instance_id: z.string().min(1),
  context: z.object({
    agent_role: z.enum(["main", "subagent"]),
    workspace_root: z.string(),
    session_id: z.string().nullable(),
    parent_session_id: z.string().nullable(),
    subagent_id: z.number().int().nullable(),
    turn_id: z.number().int().positive().nullable(),
    agent_state: z.enum(["idle", "working", "blocked"]),
    attention_kind: z.enum(["permission", "question", "route_recovery"]).nullable(),
  }),
  payload: z.record(z.string(), z.unknown()),
});

const fxStatusSchema = z.object({
  kind: z.literal("status"),
  model_source: z.string(),
  build_revision: z.string(),
  auth: z.string(),
  connected_providers: z.array(z.string()),
  permission_mode: z.string(),
});

export type FxAdeEvent = z.infer<typeof adeEventSchema>;
export type FxWorkSnapshot = z.infer<typeof workSnapshotSchema>;

export interface FxAdmission {
  delegationTurnId: string;
  disposition: "queued" | "steering";
  activeTurnId: string | null;
  snapshot: FxWorkSnapshot;
}

export interface FxTurnResult {
  turnId: string;
  outcome: "completed" | "interrupted" | "failed" | "paused";
  providerDisposition: string | null;
  assistantText: string;
  completedEvent: FxAdeEvent;
}

export interface FxIdentity {
  fxVersion: string;
  fxnkVersion: string;
  buildRevision: string;
  auth: "Codex subscription";
  modelSource: "Codex subscription";
  permissionMode: "yolo";
  model: string;
  reasoningEffort: string;
}

interface TurnWaiter {
  turnId: string;
  resolve(result: FxTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface StartedWaiter {
  resolve(event: FxAdeEvent): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class FxWorkControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Fx work control ${code}: ${message}`);
    this.name = "FxWorkControlError";
  }
}

export class FxWorkControlClient {
  private requestSequence = 0;

  constructor(
    private readonly options: {
      socketPath: string;
      instanceId: string;
      token: string;
      timeoutMs?: number;
    },
  ) {}

  async snapshot(): Promise<FxWorkSnapshot> {
    const response = await this.request("work.snapshot", {});
    if (!response.result) throw new Error("Fx work.snapshot response had no result");
    return response.result.snapshot;
  }

  async admit(text: string): Promise<FxAdmission> {
    if (text.trim().length === 0) throw new Error("cannot delegate empty work to Fx");
    const response = await this.request("work.steer", { text });
    const result = response.result;
    if (!result?.turn_id || !result.disposition) {
      throw new Error("Fx work.steer response had no admission result");
    }
    return {
      delegationTurnId: result.turn_id,
      disposition: result.disposition,
      activeTurnId: result.snapshot.active_turn_id,
      snapshot: result.snapshot,
    };
  }

  async interrupt(): Promise<FxWorkSnapshot> {
    const response = await this.request("work.interrupt", {});
    if (!response.result) throw new Error("Fx work.interrupt response had no result");
    return response.result.snapshot;
  }

  private async request(method: string, params: Record<string, unknown>) {
    const requestId = `agentvoice-${++this.requestSequence}-${randomUUID()}`;
    const payload = Buffer.from(
      JSON.stringify({
        schema: 1,
        request_id: requestId,
        instance_id: this.options.instanceId,
        token: this.options.token,
        method,
        params,
      }),
    );
    if (payload.length > MAX_CONTROL_FRAME_BYTES) {
      throw new Error(`Fx work-control request exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`);
    }
    const bytes = await exchangeFrame(
      this.options.socketPath,
      payload,
      this.options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
    );
    const parsed = workControlResponseSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (parsed.instance_id !== this.options.instanceId) {
      throw new Error("Fx work-control response came from another instance");
    }
    if (parsed.request_id !== requestId) {
      throw new Error("Fx work-control response did not match its request");
    }
    if (!parsed.ok) {
      throw new FxWorkControlError(
        parsed.error?.code ?? "unknown",
        parsed.error?.message ?? "unknown work-control failure",
      );
    }
    return parsed;
  }
}

export class FxLifecycle {
  private readonly events: FxAdeEvent[] = [];
  private readonly turnWaiters = new Set<TurnWaiter>();
  private startedWaiters: StartedWaiter[] = [];
  private lastSequence = 0;

  constructor(readonly instanceId: string) {}

  snapshot(): readonly FxAdeEvent[] {
    return this.events;
  }

  ingest(value: unknown): FxAdeEvent {
    const event = adeEventSchema.parse(value);
    if (event.instance_id !== this.instanceId) {
      throw new Error("ADE event came from another Fx instance");
    }
    if (event.sequence <= this.lastSequence) {
      throw new Error(
        `ADE sequence did not increase: observed ${event.sequence} after ${this.lastSequence}`,
      );
    }
    this.lastSequence = event.sequence;
    this.events.push(event);
    if (event.event === "FxStarted") {
      for (const waiter of this.startedWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
      this.startedWaiters = [];
    }
    this.settleTurnWaiters();
    return event;
  }

  waitForStarted(timeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<FxAdeEvent> {
    const existing = this.events.find((event) => event.event === "FxStarted");
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: StartedWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.startedWaiters.indexOf(waiter);
          if (index < 0) return;
          this.startedWaiters.splice(index, 1);
          reject(new Error(`Fx did not publish FxStarted within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.startedWaiters.push(waiter);
    });
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<FxTurnResult> {
    const existing = this.turnResult(turnId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: TurnWaiter = {
        turnId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.turnWaiters.delete(waiter);
          reject(new Error(`Fx turn ${turnId} did not complete within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.turnWaiters.add(waiter);
    });
  }

  close(reason = "Fx lifecycle closed"): void {
    const error = new Error(reason);
    for (const waiter of this.turnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    for (const waiter of this.startedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.startedWaiters = [];
  }

  private settleTurnWaiters(): void {
    for (const waiter of this.turnWaiters) {
      const result = this.turnResult(waiter.turnId);
      if (!result) continue;
      this.turnWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  private turnResult(turnId: string): FxTurnResult | undefined {
    const completedIndex = this.events.findIndex(
      (event) =>
        event.event === "PostTurnEnd" &&
        event.context.agent_role === "main" &&
        String(event.context.turn_id) === turnId,
    );
    if (completedIndex < 0) return undefined;
    const completedEvent = this.events[completedIndex]!;
    let assistantText = "";
    for (let index = 0; index < completedIndex; index++) {
      const event = this.events[index]!;
      if (
        event.event === "Stop" &&
        event.context.agent_role === "main" &&
        String(event.context.turn_id) === turnId &&
        typeof event.payload["assistant_text"] === "string"
      ) {
        assistantText = event.payload["assistant_text"];
      }
    }
    const outcome = completedEvent.payload["outcome"];
    if (!isTurnOutcome(outcome)) {
      throw new Error(`Fx turn ${turnId} ended without a recognized outcome`);
    }
    const disposition = completedEvent.payload["provider_disposition"];
    return {
      turnId,
      outcome,
      providerDisposition: typeof disposition === "string" ? disposition : null,
      assistantText,
      completedEvent,
    };
  }
}

export class FxAdeServer {
  private server: Server | null = null;

  constructor(
    private readonly options: {
      socketPath: string;
      lifecycle: FxLifecycle;
      onEvent?(event: FxAdeEvent): void;
      onProtocolError?(error: Error): void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.socketPath, () => {
        server.off("error", onError);
        chmodSync(this.options.socketPath, 0o600);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath);
  }

  private accept(socket: Socket): void {
    socket.setTimeout(1_000);
    let bytes = Buffer.alloc(0);
    let finished = false;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      this.options.onProtocolError?.(error);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_ADE_RECORD_BYTES) {
        fail(new Error(`ADE record exceeds ${MAX_ADE_RECORD_BYTES} bytes`));
        return;
      }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      if (
        bytes
          .subarray(newline + 1)
          .toString("utf8")
          .trim().length > 0
      ) {
        fail(new Error("ADE connection carried more than one record"));
        return;
      }
      try {
        const event = this.options.lifecycle.ingest(
          JSON.parse(bytes.subarray(0, newline).toString("utf8")),
        );
        finished = true;
        this.options.onEvent?.(event);
        socket.end();
      } catch (error) {
        fail(asError(error));
      }
    });
    socket.on("timeout", () => fail(new Error("ADE sender timed out")));
    socket.on("error", (error) => fail(error));
    socket.on("end", () => {
      if (!finished && bytes.length > 0) fail(new Error("ADE record had no newline terminator"));
    });
  }
}

export interface FxHeadlessOrchestratorOptions {
  workspace: string;
  fxPath?: string;
  model: string;
  reasoningEffort: string;
  terminalLogPath?: string;
  stderrLogPath?: string;
  onAdeEvent?(event: FxAdeEvent): void;
  onProtocolError?(error: Error): void;
}

export class FxHeadlessOrchestrator {
  readonly instanceId = `agentvoice-${randomUUID()}`;
  readonly lifecycle = new FxLifecycle(this.instanceId);
  readonly identity: Promise<FxIdentity>;
  readonly fatal: Promise<never>;

  private readonly tempDirectory = mkdtempSync(join(tmpdir(), "agentvoice-fx-"));
  private readonly adeSocketPath = join(this.tempDirectory, "ade.sock");
  private readonly workSocketPath = join(this.tempDirectory, "work.sock");
  private readonly token = randomBytes(32).toString("base64url");
  private readonly adeServer: FxAdeServer;
  private readonly client: FxWorkControlClient;
  private child: ChildProcessWithoutNullStreams | null = null;
  private childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private credentialBrokerChannel: Duplex | null = null;
  private terminalTail = "";
  private stderrTail = "";
  private startPromise: Promise<FxIdentity> | null = null;
  private stopPromise: Promise<void> | null = null;
  private rejectFatal: ((error: Error) => void) | null = null;
  private ready = false;
  private stopped = false;

  constructor(private readonly options: FxHeadlessOrchestratorOptions) {
    this.fatal = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatal.catch(() => {});
    chmodSync(this.tempDirectory, 0o700);
    this.adeServer = new FxAdeServer({
      socketPath: this.adeSocketPath,
      lifecycle: this.lifecycle,
      ...(options.onAdeEvent ? { onEvent: options.onAdeEvent } : {}),
      onProtocolError: (error) => {
        options.onProtocolError?.(error);
        this.fail(error);
      },
    });
    this.client = new FxWorkControlClient({
      socketPath: this.workSocketPath,
      instanceId: this.instanceId,
      token: this.token,
    });
    this.identity = this.probeIdentity();
  }

  start(): Promise<FxIdentity> {
    if (this.stopped) throw new Error("cannot restart a stopped Fx orchestrator");
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  async admit(text: string): Promise<FxAdmission> {
    if (!this.ready || this.stopped) throw new Error("Fx orchestrator is not running");
    return this.client.admit(text);
  }

  async snapshot(): Promise<FxWorkSnapshot> {
    if (!this.ready || this.stopped) throw new Error("Fx orchestrator is not running");
    return this.client.snapshot();
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<FxTurnResult> {
    if (!this.ready || this.stopped) {
      return Promise.reject(new Error("Fx orchestrator is not running"));
    }
    return this.lifecycle.waitForTurn(turnId, timeoutMs);
  }

  /**
   * Transfers the sole AgentVoice-owned endpoint of Fx's credential broker.
   * The caller must keep the socket opaque and pass it directly to an
   * Fx-authorized voice sidecar as inherited descriptor 3.
   */
  acquireCredentialBrokerChannel(): Duplex {
    if (!this.ready || this.stopped) {
      throw new Error("Fx credential broker is unavailable before Fx startup");
    }
    const channel = this.credentialBrokerChannel;
    if (!channel) throw new Error("Fx credential broker channel was already acquired");
    this.credentialBrokerChannel = null;
    channel.pause();
    return channel;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.lifecycle.close();
    const credentialBrokerChannel = this.credentialBrokerChannel;
    this.credentialBrokerChannel = null;
    credentialBrokerChannel?.destroy();
    const child = this.child;
    let stopError: Error | null = null;
    try {
      if (child?.pid) await stopProcessGroup(child.pid);
      if (this.childExit) await settlesWithin(this.childExit, KILL_TIMEOUT_MS);
    } catch (error) {
      stopError = asError(error);
    } finally {
      await this.adeServer.close();
      rmSync(this.tempDirectory, { recursive: true, force: true });
    }
    if (stopError) throw stopError;
  }

  private async startOnce(): Promise<FxIdentity> {
    try {
      const identity = await this.identity;
      this.assertStarting();
      await this.adeServer.start();
      this.assertStarting();

      const fxPath = this.options.fxPath ?? "fx";
      const environment = fxEnvironment({
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort,
        adeSocketPath: this.adeSocketPath,
        workSocketPath: this.workSocketPath,
        instanceId: this.instanceId,
        token: this.token,
        credentialFd: 3,
      });
      const launch = ptyLaunch(fxPath);
      if (process.platform === "darwin") environment["AGENTVOICE_FX_EXECUTABLE"] = fxPath;
      const child = spawn(launch.command, launch.args, {
        cwd: resolve(this.options.workspace),
        env: environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.childExit = new Promise((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      });
      const terminalLog = this.options.terminalLogPath
        ? createWriteStream(this.options.terminalLogPath, { flags: "wx", mode: 0o600 })
        : null;
      const stderrLog = this.options.stderrLogPath
        ? createWriteStream(this.options.stderrLogPath, { flags: "wx", mode: 0o600 })
        : null;
      child.stdout.on("data", (chunk: Buffer) => {
        terminalLog?.write(chunk);
        this.terminalTail = boundedTail(this.terminalTail, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrLog?.write(chunk);
        this.stderrTail = boundedTail(this.stderrTail, chunk);
      });
      child.once("exit", () => {
        terminalLog?.end();
        stderrLog?.end();
      });
      void this.childExit.then(
        ({ code, signal }) => {
          if (!this.stopped) {
            const phase = this.ready ? "during the active session" : "during startup";
            this.fail(
              new Error(
                `Fx exited ${phase} (code ${code}, signal ${signal ?? "none"})\n${this.logTail()}`,
              ),
            );
          }
        },
        (error) => this.fail(asError(error)),
      );

      await waitForSpawn(child);
      this.assertStarting();
      const credentialBrokerChannel = child.stdio[3];
      if (!isDuplex(credentialBrokerChannel)) {
        throw new Error("Fx credential broker did not expose a parent Duplex for descriptor 3");
      }
      credentialBrokerChannel.pause();
      this.credentialBrokerChannel = credentialBrokerChannel;

      const started = this.lifecycle.waitForStarted();
      const exited = this.childExit.then(({ code, signal }) => {
        throw new Error(
          `Fx exited before startup (code ${code}, signal ${signal ?? "none"})\n${this.logTail()}`,
        );
      });
      await Promise.race([started, exited, this.fatal]);
      this.assertStarting();
      await this.client.snapshot();
      this.assertStarting();
      this.ready = true;
      return identity;
    } catch (error) {
      try {
        await this.stop();
      } catch (stopError) {
        throw new AggregateError(
          [asError(error), asError(stopError)],
          "Fx startup failed and rollback also failed",
        );
      }
      throw error;
    }
  }

  private assertStarting(): void {
    if (this.stopped) throw new Error("Fx orchestrator stopped during startup");
  }

  private fail(error: Error): void {
    if (this.stopped || !this.rejectFatal) return;
    this.ready = false;
    this.lifecycle.close(error.message);
    this.rejectFatal(error);
    this.rejectFatal = null;
  }

  private async probeIdentity(): Promise<FxIdentity> {
    const fxPath = this.options.fxPath ?? "fx";
    const environment = fxEnvironment();
    const [statusText, versionText, fxnkText] = await Promise.all([
      commandOutput(fxPath, ["status", "--json"], this.options.workspace, environment),
      commandOutput(fxPath, ["--version"], this.options.workspace, environment),
      commandOutput(fxPath, ["--fxnk-version"], this.options.workspace, environment),
    ]);
    const status = fxStatusSchema.parse(JSON.parse(statusText));
    if (
      status.auth !== "Codex subscription" ||
      status.model_source !== "Codex subscription" ||
      !status.connected_providers.includes("codex")
    ) {
      throw new Error("Fx is not authenticated through the Codex subscription");
    }
    if (status.permission_mode !== "yolo") {
      throw new Error(`Fx permission mode must be yolo; observed ${status.permission_mode}`);
    }
    return {
      fxVersion: versionText.trim(),
      fxnkVersion: fxnkText.trim(),
      buildRevision: status.build_revision,
      auth: "Codex subscription",
      modelSource: "Codex subscription",
      permissionMode: "yolo",
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
    };
  }

  private logTail(): string {
    return [this.stderrTail, this.terminalTail].filter(Boolean).join("\n");
  }
}

function exchangeFrame(socketPath: string, payload: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(value!);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === null && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0);
        if (expected < 1 || expected > MAX_CONTROL_FRAME_BYTES) {
          finish(new Error(`invalid Fx work-control response length ${expected}`));
          return;
        }
      }
      if (expected !== null && buffer.length >= expected + 4) {
        if (buffer.length !== expected + 4) {
          finish(new Error("Fx work-control response carried trailing bytes"));
          return;
        }
        finish(undefined, buffer.subarray(4));
      }
    });
    socket.once("timeout", () => finish(new Error(`Fx work-control request timed out`)));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("Fx work-control response ended before one complete frame"));
    });
  });
}

export function fxEnvironment(
  options: {
    model?: string;
    reasoningEffort?: string;
    adeSocketPath?: string;
    workSocketPath?: string;
    instanceId?: string;
    token?: string;
    credentialFd?: 3;
  } = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = environmentWithoutOpenAiApiKey(inherited);
  environment["FX_AUTO_UPGRADE"] = "0";
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("LIVEKIT_") ||
      name.startsWith("AGENTVOICE_") ||
      name.startsWith("HERDR_") ||
      name.startsWith("FX_ADE_") ||
      name.startsWith("FX_WORK_CONTROL_")
    ) {
      delete environment[name];
    }
  }
  delete environment["FX_CODEX_CREDENTIAL_FD"];
  if (options.model) environment["FX_MODEL"] = options.model;
  if (options.reasoningEffort) environment["FX_EFFORT"] = options.reasoningEffort;
  if (options.adeSocketPath) environment["FX_ADE_SOCKET_PATH"] = options.adeSocketPath;
  if (options.instanceId) environment["FX_ADE_INSTANCE_ID"] = options.instanceId;
  if (options.workSocketPath) environment["FX_WORK_CONTROL_SOCKET_PATH"] = options.workSocketPath;
  if (options.instanceId) environment["FX_WORK_CONTROL_INSTANCE_ID"] = options.instanceId;
  if (options.token) environment["FX_WORK_CONTROL_TOKEN"] = options.token;
  if (options.credentialFd) {
    environment["FX_CODEX_CREDENTIAL_FD"] = String(options.credentialFd);
  }
  return environment;
}

function ptyLaunch(fxPath: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    // macOS `script` calls tcgetattr on its own stdin and fails when spawned
    // headlessly with pipes. Expect allocates a real child PTY independently
    // of the parent stdio. The executable travels through the environment so
    // Tcl never evaluates path contents as source text.
    return {
      command: "/usr/bin/expect",
      args: [
        "-N",
        "-n",
        "-c",
        [
          "log_user 1",
          "set timeout -1",
          "set stty_init {rows 40 columns 120}",
          "set executable $env(AGENTVOICE_FX_EXECUTABLE)",
          "unset env(AGENTVOICE_FX_EXECUTABLE)",
          "spawn -noecho $executable",
          "expect eof",
          "catch wait result",
          "exit [lindex $result 3]",
        ].join("; "),
      ],
    };
  }
  return {
    command: "script",
    args: ["-q", "-c", shellQuote(fxPath), "/dev/null"],
  };
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const fallback = setImmediate(() => {
      if (child.pid !== undefined) onSpawn();
    });
    const onSpawn = () => {
      clearImmediate(fallback);
      child.off("error", onError);
      child.off("spawn", onSpawn);
      resolvePromise();
    };
    const onError = (error: Error) => {
      clearImmediate(fallback);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function isDuplex(value: unknown): value is Duplex {
  return (
    typeof value === "object" &&
    value !== null &&
    "pause" in value &&
    typeof value.pause === "function" &&
    "write" in value &&
    typeof value.write === "function" &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
}

async function stopProcessGroup(pid: number): Promise<void> {
  if (!(await processGroupExists(pid))) return;
  signalProcessGroup(pid, "SIGINT");
  if (await processGroupSettlesWithin(pid, GRACEFUL_STOP_TIMEOUT_MS)) return;
  signalProcessGroup(pid, "SIGTERM");
  if (await processGroupSettlesWithin(pid, TERMINATE_TIMEOUT_MS)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (await processGroupSettlesWithin(pid, KILL_TIMEOUT_MS)) return;
  throw new Error(`Fx process group ${pid} survived SIGKILL`);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function processGroupExists(pid: number): Promise<boolean> {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function processGroupSettlesWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!(await processGroupExists(pid))) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !(await processGroupExists(pid));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function commandOutput(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 1024 * 1024) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
  });
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const errors = Buffer.concat(stderr).toString("utf8");
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (code ${code}, signal ${signal ?? "none"}): ${errors.trim()}`,
    );
  }
  if (stdoutBytes > 1024 * 1024 || stderrBytes > 1024 * 1024) {
    throw new Error(`${command} ${args.join(" ")} exceeded its output bound`);
  }
  return output;
}

function boundedTail(previous: string, chunk: Buffer): string {
  return (previous + chunk.toString("utf8")).slice(-64 * 1024);
}

function isTurnOutcome(value: unknown): value is FxTurnResult["outcome"] {
  return (
    value === "completed" || value === "interrupted" || value === "failed" || value === "paused"
  );
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), timeoutMs)),
  ]);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
