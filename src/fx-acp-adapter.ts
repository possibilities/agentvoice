/**
 * Fx over the Agent Client Protocol: the backend of record. Standard ACP gives
 * one prompt per turn, streamed agent-message chunks, cancellation, and
 * permission requests. In-flight steering and ADE-parity lifecycle arrive with
 * Fx's `acp-voice-control` carry as `_fx/…` extensions; until a server answers
 * them, a second admission during an active turn is queued behind it and
 * reported as such — never claimed as steering.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { fxEnvironment } from "./fx-orchestrator.ts";
import {
  LifecycleEmitter,
  type OrchestratorAdapter,
  type OrchestratorAdmission,
  type OrchestratorAgentState,
  type OrchestratorCapabilities,
  type OrchestratorIdentity,
  type OrchestratorLifecycleListener,
  type OrchestratorTurnOutcome,
  type OrchestratorTurnResult,
} from "./orchestrator-adapter.ts";

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 5_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const STEER_METHOD = "_fx/session/steer";

const initializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  agentCapabilities: z.record(z.string(), z.unknown()).optional(),
});
const sessionNewResultSchema = z.object({
  sessionId: z.string().min(1),
  configOptions: z
    .array(z.object({ id: z.string(), currentValue: z.unknown().optional() }))
    .optional(),
  modes: z.object({ currentModeId: z.string() }).optional(),
});
const promptResultSchema = z.object({ stopReason: z.string() });
const steerResultSchema = z.object({
  turnId: z.string(),
  disposition: z.enum(["queued", "steering"]),
});
const permissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});
const permissionRequestSchema = z.object({
  sessionId: z.string(),
  toolCall: z.unknown().optional(),
  options: z.array(permissionOptionSchema).min(1),
});
const sessionUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});
const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export type AcpPermissionOption = z.infer<typeof permissionOptionSchema>;
export type AcpPermissionRequest = z.infer<typeof permissionRequestSchema>;
export type AcpSessionUpdate = z.infer<typeof sessionUpdateSchema>;
export type AcpPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export class FxAcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "FxAcpError";
  }
}

export interface FxAcpAdapterOptions {
  workspace: string;
  model: string;
  reasoningEffort: string;
  fxPath?: string;
  /** ACP session mode set right after `session/new`; `code` is Fx's auto-permission mode. */
  sessionMode?: string | null;
  /** Replaces the `fx acp …` command line; tests point this at a fake server. */
  launch?: { command: string; args: string[]; env?: Record<string, string> };
  requestTimeoutMs?: number;
  stderrLogPath?: string;
  onPermissionRequest?(request: AcpPermissionRequest): Promise<AcpPermissionDecision>;
  onUpdate?(update: AcpSessionUpdate): void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TurnWaiter {
  resolve(result: OrchestratorTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AcpTurn {
  turnId: string;
  text: string;
  assistantText: string;
  result: OrchestratorTurnResult | null;
  waiters: TurnWaiter[];
}

/** Picks the least-privileged allow option, so an unattended session keeps moving. */
export function defaultPermissionDecision(request: AcpPermissionRequest): AcpPermissionDecision {
  const preferred = ["allow_once", "allow_always"];
  for (const kind of preferred) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "selected", optionId: request.options[0]!.optionId };
}

export function outcomeFromStopReason(stopReason: string): OrchestratorTurnOutcome {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "interrupted";
    default:
      return "failed";
  }
}

export class FxAcpAdapter implements OrchestratorAdapter {
  readonly backend = "fx-acp";
  readonly capabilities: OrchestratorCapabilities = {
    steering: false,
    interrupt: true,
    attention: true,
  };

  private readonly lifecycle = new LifecycleEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, AcpTurn>();
  private readonly queue: AcpTurn[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private stderrLog: WriteStream | null = null;
  private stderrTail = "";
  private lineBuffer = "";
  private requestSequence = 0;
  private turnSequence = 0;
  private sessionId: string | null = null;
  private activeTurn: AcpTurn | null = null;
  private pendingAttention = 0;
  private steering: "unknown" | "supported" | "unsupported" = "unknown";
  private startPromise: Promise<OrchestratorIdentity> | null = null;
  private stopPromise: Promise<void> | null = null;
  private ready = false;
  private stopped = false;

  constructor(private readonly options: FxAcpAdapterOptions) {}

  start(): Promise<OrchestratorIdentity> {
    if (this.stopped) throw new Error("cannot restart a stopped Fx ACP adapter");
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  async admit(text: string): Promise<OrchestratorAdmission> {
    this.assertRunning();
    const active = this.activeTurn;
    if (active) {
      const steered = await this.trySteer(text);
      if (steered) {
        return {
          delegationTurnId: steered.delegationTurnId,
          disposition: "steering",
          activeTurnId: steered.activeTurnId,
        };
      }
      const turn = this.createTurn(text);
      this.queue.push(turn);
      return { delegationTurnId: turn.turnId, disposition: "queued", activeTurnId: active.turnId };
    }
    const turn = this.createTurn(text);
    this.startTurn(turn);
    return { delegationTurnId: turn.turnId, disposition: "queued", activeTurnId: null };
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<OrchestratorTurnResult> {
    const turn = this.turns.get(turnId);
    if (!turn) return Promise.reject(new Error(`unknown Fx ACP turn ${turnId}`));
    if (turn.result) return Promise.resolve(turn.result);
    if (this.stopped) return Promise.reject(new Error("Fx ACP adapter is not running"));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        turn.waiters = turn.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Fx ACP turn ${turnId} did not end within ${timeoutMs}ms`));
      }, timeoutMs);
      turn.waiters.push({ resolve: resolvePromise, reject, timer });
    });
  }

  async interrupt(): Promise<void> {
    this.assertRunning();
    const active = this.activeTurn;
    if (!active) return;
    const ended = new Promise<void>((resolvePromise) => {
      active.waiters.push({
        resolve: () => resolvePromise(),
        reject: () => resolvePromise(),
        timer: setTimeout(() => {}, 0),
      });
    });
    await this.request("session/cancel", { sessionId: this.sessionId });
    await ended;
  }

  onLifecycle(listener: OrchestratorLifecycleListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  /** Every lifecycle event so far, for evidence and tests. */
  lifecycleSnapshot() {
    return this.lifecycle.snapshot();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async startOnce(): Promise<OrchestratorIdentity> {
    const launch = this.options.launch ?? {
      command: this.options.fxPath ?? "fx",
      args: ["acp", "--model", this.options.model, "--effort", this.options.reasoningEffort],
    };
    const environment = fxEnvironment({
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
    });
    Object.assign(environment, launch.env ?? {});
    const child = spawn(launch.command, launch.args, {
      cwd: resolve(this.options.workspace),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.childExit = new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    if (this.options.stderrLogPath) {
      this.stderrLog = createWriteStream(this.options.stderrLogPath, { flags: "wx", mode: 0o600 });
    }
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrLog?.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    void this.childExit.then(
      ({ code, signal }) => this.onExit(`Fx ACP exited (code ${code}, signal ${signal ?? "none"})`),
      (error) => this.onExit(`Fx ACP failed to start: ${errorMessage(error)}`),
    );

    try {
      const initialized = initializeResultSchema.parse(
        await this.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
      );
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new FxAcpError(
          `Fx ACP protocol version ${initialized.protocolVersion} is not ${ACP_PROTOCOL_VERSION}`,
        );
      }
      const extension = initialized.agentCapabilities?.["_fx"];
      if (isRecord(extension) && extension["steer"] === true) this.markSteering("supported");

      const session = sessionNewResultSchema.parse(
        await this.request("session/new", {
          cwd: resolve(this.options.workspace),
          mcpServers: [],
        }),
      );
      this.sessionId = session.sessionId;
      const mode = this.options.sessionMode === undefined ? "code" : this.options.sessionMode;
      if (mode)
        await this.request("session/set_mode", { sessionId: session.sessionId, modeId: mode });

      const configured = new Map(
        (session.configOptions ?? []).map((option) => [option.id, option.currentValue]),
      );
      const identity: OrchestratorIdentity = {
        backend: this.backend,
        version: initialized.agentInfo?.version ?? "unknown",
        buildRevision: null,
        auth: stringOrNull(configured.get("provider")),
        modelSource: stringOrNull(configured.get("provider")),
        permissionMode: mode ?? session.modes?.currentModeId ?? null,
        model: stringOrNull(configured.get("model")) ?? this.options.model,
        reasoningEffort: this.options.reasoningEffort,
      };
      if (identity.model !== this.options.model) {
        throw new FxAcpError(
          `Fx ACP session model ${identity.model} is not the requested ${this.options.model}`,
        );
      }
      this.ready = true;
      this.lifecycle.emit({
        type: "orchestrator.started",
        turnId: null,
        agentState: "idle",
        attentionKind: null,
        data: { sessionId: session.sessionId, identity },
      });
      return identity;
    } catch (error) {
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end();
      } catch {
        // The peer may already be gone.
      }
      const exited = this.childExit ?? Promise.resolve(null);
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolvePromise) =>
          setTimeout(() => resolvePromise(false), TERMINATE_GRACE_MS),
        ),
      ]);
      if (!graceful) {
        signalProcessGroup(child, "SIGTERM");
        const terminated = await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolvePromise) =>
            setTimeout(() => resolvePromise(false), TERMINATE_GRACE_MS),
          ),
        ]);
        if (!terminated) {
          signalProcessGroup(child, "SIGKILL");
          await exited.catch(() => null);
        }
      }
    }
    this.failEverything(new Error("Fx ACP adapter stopped"));
    this.stderrLog?.end();
  }

  private onExit(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    const detail = this.stderrTail.trim();
    this.failEverything(new Error(detail ? `${reason}\n${detail}` : reason));
    this.lifecycle.emit({
      type: "orchestrator.stopped",
      turnId: null,
      agentState: "idle",
      attentionKind: null,
      data: { reason },
    });
  }

  private failEverything(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    const active = this.activeTurn;
    if (active) this.settleTurn(active, "failed", null, error.message);
    for (const turn of this.queue.splice(0)) this.settleTurn(turn, "failed", null, error.message);
  }

  private assertRunning(): void {
    if (!this.ready || this.stopped) throw new Error("Fx ACP adapter is not running");
  }

  private createTurn(text: string): AcpTurn {
    const turn: AcpTurn = {
      turnId: `acp-turn-${++this.turnSequence}`,
      text,
      assistantText: "",
      result: null,
      waiters: [],
    };
    this.turns.set(turn.turnId, turn);
    return turn;
  }

  private startTurn(turn: AcpTurn): void {
    this.activeTurn = turn;
    this.lifecycle.emit({
      type: "turn.started",
      turnId: turn.turnId,
      agentState: "working",
      attentionKind: null,
      data: { text: turn.text },
    });
    this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text: turn.text }] },
      null,
    ).then(
      (result) => {
        const parsed = promptResultSchema.safeParse(result);
        if (!parsed.success) {
          this.settleTurn(turn, "failed", null, "Fx ACP prompt response had no stopReason");
          return;
        }
        this.settleTurn(
          turn,
          outcomeFromStopReason(parsed.data.stopReason),
          parsed.data.stopReason,
        );
      },
      (error: unknown) => this.settleTurn(turn, "failed", null, errorMessage(error)),
    );
  }

  private settleTurn(
    turn: AcpTurn,
    outcome: OrchestratorTurnOutcome,
    providerDisposition: string | null,
    failure?: string,
  ): void {
    if (turn.result) return;
    const assistantText =
      outcome === "failed" && failure && !turn.assistantText ? failure : turn.assistantText;
    turn.result = { turnId: turn.turnId, outcome, providerDisposition, assistantText };
    if (this.activeTurn === turn) this.activeTurn = null;
    this.lifecycle.emit({
      type: "turn.ended",
      turnId: turn.turnId,
      agentState: this.agentState(),
      attentionKind: null,
      data: { outcome, providerDisposition, ...(failure ? { failure } : {}) },
    });
    for (const waiter of turn.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(turn.result);
    }
    if (!this.activeTurn && !this.stopped) {
      const next = this.queue.shift();
      if (next) this.startTurn(next);
    }
  }

  private async trySteer(
    text: string,
  ): Promise<{ delegationTurnId: string; activeTurnId: string } | null> {
    if (this.steering === "unsupported") return null;
    try {
      const result = steerResultSchema.parse(
        await this.request(STEER_METHOD, { sessionId: this.sessionId, text }),
      );
      this.markSteering("supported");
      if (result.disposition !== "steering") return null;
      const entry = this.createTurn(text);
      const active = this.activeTurn;
      if (active) {
        active.waiters.push({
          resolve: (outcome) =>
            this.settleTurn(entry, outcome.outcome, outcome.providerDisposition),
          reject: (error) => this.settleTurn(entry, "failed", null, error.message),
          timer: setTimeout(() => {}, 0),
        });
      }
      return { delegationTurnId: entry.turnId, activeTurnId: result.turnId };
    } catch (error) {
      if (error instanceof FxAcpError && error.code === JSON_RPC_METHOD_NOT_FOUND) {
        this.markSteering("unsupported");
        return null;
      }
      throw error;
    }
  }

  private markSteering(state: "supported" | "unsupported"): void {
    this.steering = state;
    this.capabilities.steering = state === "supported";
  }

  private agentState(): OrchestratorAgentState {
    if (this.pendingAttention > 0) return "blocked";
    return this.activeTurn ? "working" : "idle";
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || this.stopped) return Promise.reject(new Error("Fx ACP adapter is not running"));
    const id = ++this.requestSequence;
    return new Promise((resolvePromise, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new FxAcpError(`Fx ACP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");
    if (this.lineBuffer.length > MAX_LINE_BYTES) {
      this.onExit(`Fx ACP emitted a line over ${MAX_LINE_BYTES} bytes`);
      this.child?.kill("SIGKILL");
      return;
    }
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderrTail = `${this.stderrTail}\nnon-JSON ACP line: ${line.slice(0, 200)}`.slice(-4096);
      return;
    }
    if (!isRecord(message)) return;
    const id = message["id"];
    const method = message["method"];
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      void this.handleServerRequest(id, method, message["params"]);
      return;
    }
    if (typeof method === "string") {
      this.handleNotification(method, message["params"]);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in message && message["error"] !== undefined && message["error"] !== null) {
      const parsed = rpcErrorSchema.safeParse(message["error"]);
      pending.reject(
        parsed.success
          ? new FxAcpError(
              `Fx ACP ${pending.method} failed: ${parsed.data.message}`,
              parsed.data.code,
            )
          : new FxAcpError(`Fx ACP ${pending.method} failed`),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = sessionUpdateSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
    this.options.onUpdate?.(parsed.data);
    const update = parsed.data.update;
    if (update["sessionUpdate"] !== "agent_message_chunk") return;
    const content = update["content"];
    if (!isRecord(content) || content["type"] !== "text" || typeof content["text"] !== "string") {
      return;
    }
    const active = this.activeTurn;
    if (active) active.assistantText += content["text"];
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      this.respond(id, null, { code: JSON_RPC_METHOD_NOT_FOUND, message: `unsupported ${method}` });
      return;
    }
    const parsed = permissionRequestSchema.safeParse(params);
    if (!parsed.success) {
      this.respond(id, null, { code: -32602, message: "malformed permission request" });
      return;
    }
    const turnId = this.activeTurn?.turnId ?? null;
    this.pendingAttention += 1;
    this.lifecycle.emit({
      type: "attention.raised",
      turnId,
      agentState: "blocked",
      attentionKind: "permission",
      data: { options: parsed.data.options, toolCall: parsed.data.toolCall ?? null },
    });
    let decision: AcpPermissionDecision;
    try {
      decision = await (this.options.onPermissionRequest ?? defaultPermissionDecision)(parsed.data);
    } catch (error) {
      decision = { outcome: "cancelled" };
      this.stderrTail =
        `${this.stderrTail}\npermission handler failed: ${errorMessage(error)}`.slice(-4096);
    }
    this.pendingAttention -= 1;
    this.lifecycle.emit({
      type: "attention.cleared",
      turnId,
      agentState: this.agentState(),
      attentionKind: "permission",
      data: { decision },
    });
    this.respond(id, {
      outcome:
        decision.outcome === "selected"
          ? { outcome: "selected", optionId: decision.optionId }
          : { outcome: "cancelled" },
    });
  }

  private respond(
    id: number | string,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? null };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`, () => {});
  }
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
