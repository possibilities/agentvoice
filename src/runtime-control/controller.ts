/** Server-owned call authority. Media and UI remain in separate processes. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachmentTargetSchema } from "../attachment/bootstrap.ts";
import type { AttachmentTicket } from "../attachment/gateway.ts";
import { MuteGate } from "../console/audio-control.ts";
import type { VoiceState } from "../console/state.ts";
import { startControlServer } from "../control/index.ts";
import {
  CONTROL_MCP_SERVER_NAME,
  CONTROL_MCP_TOOLS,
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  ControlError,
  type ControlMutationRequest,
  type ControlOperation,
  type ControlOperationPhase,
  type ControlRestartRequest,
  type ControlServer,
  type ControlStatus,
} from "../control/types.ts";
import type { ControlMcpRegistration } from "../core/control-mcp.ts";
import {
  type HandoffResult,
  handoffFailure,
  handoffPromptSchema,
  handoffResultSchema,
  handoffUnknown,
} from "../core/handoff.ts";
import { lockThread } from "../core/thread-lock.ts";
import { threadInventorySchema } from "../events/contract.ts";
import {
  type ConversationReadMethod,
  type ConversationReadParams,
  conversationNotification,
  conversationRequestSchemas,
  ObservationError,
  observationErrorCode,
  readResultSchema,
} from "../events/conversation.ts";
import { LifecycleFeed } from "../events/feed.ts";
import { EventSocketServer, eventSocketPath } from "../events/socket.ts";
import { voiceNotification } from "../events/voice.ts";
import {
  inFlightSchema,
  type MailboxCaller,
  type MailboxOpenParams,
  type MailboxOpenResult,
  mailboxObservationSchema,
  mailboxOpenParams,
  type WakeOutcome,
  wakeOutcomeSchema,
} from "../mailbox/contract.ts";
import { ThreadMailbox } from "../mailbox/state.ts";
import { stateDirectory } from "../paths.ts";
import { recordCall } from "../recording/call.ts";
import { type JournalOperation, OperationJournal, publicOperation } from "./journal.ts";
import { type RuntimeProcess, spawnRuntimeProcess } from "./process.ts";
import type { CandidateInfo, LaunchProvenance, RuntimeLaunch } from "./protocol.ts";

export interface ControllerOptions {
  instanceId: string;
  stateDir: string;
  provenance: LaunchProvenance;
  version: string;
  control: ControlMcpRegistration;
  lifecycle?: LifecycleFeed;
  changed?(): void;
  spawn?: typeof spawnRuntimeProcess;
  lease?: (threadId: string) => () => void;
}

export class RuntimeController implements ControlBackend {
  readonly lifecycle: LifecycleFeed;
  private readonly journal: OperationJournal;
  private readonly mailbox: ThreadMailbox;
  private readonly leases = new Map<string, () => void>();
  private active: RuntimeProcess | undefined;
  private candidate: RuntimeProcess | undefined;
  private generation = 1;
  private incarnation = 0;
  private activeIncarnation = 0;
  private workspace = "";
  private threadId = "";
  private buildId: string | undefined;
  private phase = "starting";
  private operation: ControlOperation | undefined;
  private busy = false;
  private started = false;
  private observationPending = 0;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private background: Promise<void> | undefined;
  private voice: VoiceState = {
    available: true,
    phase: "waiting-ready",
    mic: { muted: false, effectiveMuted: false },
    speaker: { muted: false, effectiveMuted: false },
  };
  readonly microphone = new MuteGate();
  readonly speaker = new MuteGate();

  constructor(private readonly options: ControllerOptions) {
    this.lifecycle = options.lifecycle ?? new LifecycleFeed(options.instanceId);
    this.mailbox = new ThreadMailbox(options.instanceId, (event, data) =>
      this.lifecycle.mailbox(event, data),
    );
    this.lifecycle.mailbox("mailbox.changed", { state: this.mailbox.snapshot() });
    this.journal = new OperationJournal(
      join(options.stateDir, "operations", `${options.instanceId}.jsonl`),
    );
  }
  status(): ControlStatus {
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      workspace: this.workspace,
      threadId: this.threadId,
      generation: this.generation,
      runtime: {
        pid: this.active?.pid,
        buildId: this.buildId,
        phase: this.phase,
        voicePhase: this.voice.phase,
      },
      currentOperation: this.operation && structuredClone(this.operation),
      recentOperations: this.journal.all().slice(-16).map(publicOperation),
    };
  }
  async attachmentTicket(value: unknown): Promise<AttachmentTicket> {
    const target = attachmentTargetSchema.parse(value);
    const current = () =>
      !this.closed &&
      !this.busy &&
      this.phase === "ready" &&
      target.instanceId === this.options.instanceId &&
      target.generation === this.generation &&
      target.threadId === this.threadId &&
      target.workspace === this.workspace;
    if (!current() || !this.active)
      throw new Error("Attachment unavailable; select the current live thread");
    const active = this.active;
    const ticket = await active.request<AttachmentTicket>("attachment-ticket", {
      threadId: this.threadId,
    });
    if (!current() || active !== this.active) throw new Error("Attachment target changed");
    return ticket;
  }
  state(): VoiceState {
    const ready = this.phase === "ready";
    return {
      ...this.voice,
      available: !this.closed,
      workspace: this.workspace,
      mic: {
        muted: this.microphone.muted,
        effectiveMuted: !ready || this.microphone.effectiveMuted,
      },
      speaker: {
        muted: this.speaker.muted,
        effectiveMuted: !ready || this.speaker.effectiveMuted,
      },
    };
  }
  private changed() {
    this.lifecycle.runtime(this.generation, {
      phase: this.phase,
      workspace: this.workspace,
      mainThreadId: this.threadId,
    });
    this.options.changed?.();
  }
  private notice(message: string) {
    this.voice.notice = message;
    this.changed();
  }
  private assertOpen() {
    if (this.closed) throw new Error("Controller is shutting down");
  }
  private acquire = async (id: string): Promise<void> => {
    this.assertOpen();
    if (!this.leases.has(id))
      this.leases.set(
        id,
        this.options.lease?.(id) ?? lockThread(join(this.options.stateDir, "thread-locks"), id),
      );
  };
  private newProcess(): { process: RuntimeProcess; incarnation: number } {
    const incarnation = ++this.incarnation;
    const process = (this.options.spawn ?? spawnRuntimeProcess)(
      incarnation,
      (method, params) => this.event(incarnation, method, params),
      async (id) => {
        if (incarnation !== this.activeIncarnation)
          throw new Error("Obsolete runtime cannot acquire a thread lease");
        await this.acquire(id);
      },
    );
    return { process, incarnation };
  }
  private event(incarnation: number, method: string, params: unknown) {
    if (incarnation !== this.activeIncarnation || (this.closed && method !== "voice")) return;
    if (method === "mailbox") {
      const parsed = mailboxObservationSchema.safeParse(params);
      if (!parsed.success) {
        this.mailbox.gap("inventory");
        return;
      }
      if (!["starting", "ready"].includes(this.phase)) return;
      const observation = parsed.data;
      switch (observation.kind) {
        case "inventory":
          this.mailbox.update(observation.inventory);
          break;
        case "started":
          this.lifecycle.mailbox("mailbox.child.started", {
            child: observation.child,
            observedAt: observation.observedAt,
          });
          break;
        case "completed": {
          const eventId = this.mailbox.complete(observation.completion, this.generation);
          if (eventId) void this.submitMailboxWake(eventId);
          break;
        }
        case "submitting":
          if (
            observation.notice.instanceId === this.options.instanceId &&
            observation.notice.rootThreadId === this.threadId
          )
            this.mailbox.submitting(observation.notice, this.generation);
          break;
        case "recorded":
          this.mailbox.recorded(
            observation.eventId,
            this.generation,
            observation.turnId,
            observation.itemId,
          );
          break;
        case "gap":
          this.mailbox.gap(observation.reason);
          break;
      }
      return;
    }
    if (method === "conversation") {
      const checked = conversationNotification(params);
      if (checked) this.lifecycle.conversation(checked);
      return;
    }
    if (method === "voice") {
      const checked = voiceNotification(params);
      if (
        checked &&
        checked.data.threadId === this.threadId &&
        this.leases.has(checked.data.threadId)
      )
        this.lifecycle.voice(checked);
      return;
    }
    if (method === "threads") {
      const checked = threadInventorySchema.safeParse(params);
      if (checked.success) this.lifecycle.update(checked.data);
      else this.lifecycle.update({ threads: this.lifecycle.snapshot().threads, complete: false });
      return;
    }
    if (method === "identity") {
      if (this.phase === "failed") return;
      const identity = params as { threadId: string; workspace: string };
      if (identity.workspace !== this.workspace || !this.leases.has(identity.threadId)) {
        this.phase = "failed";
        this.voice.phase = "failed";
        this.notice("Runtime reported an unleased or foreign identity");
        void this.active?.stop().catch(() => {});
        return;
      }
      this.threadId = identity.threadId;
    } else if (method === "state") {
      if (this.phase === "failed") return;
      const state = params as VoiceState;
      if (state.conversation) {
        if (
          state.conversation.workspace !== this.workspace ||
          !this.leases.has(state.conversation.threadId)
        ) {
          this.notice("Runtime reported an unleased or foreign conversation");
          void this.active?.stop();
          return;
        }
        this.threadId = state.conversation.threadId;
      }
      this.voice = structuredClone(state);
    } else if (method === "fatal" || (method === "exit" && this.phase === "ready")) {
      this.phase = "failed";
      this.voice.phase = "failed";
      this.voice.notice =
        method === "fatal"
          ? (params as { message: string }).message
          : "Runtime exited; restart runtime to retry";
      this.cancelHolds();
      this.mailbox.unavailableRuntime();
    }
    this.changed();
  }
  async start(): Promise<void> {
    this.assertOpen();
    if (this.started) throw new Error("Call already started");
    this.started = true;
    this.busy = true;
    try {
      await this.replace();
    } catch (error) {
      this.phase = "failed";
      this.voice.phase = "failed";
      this.notice(String(error));
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  private async replace(operation?: JournalOperation): Promise<void> {
    this.assertOpen();
    const handoffTarget = operation?.handoffPayload;
    const candidate = this.newProcess();
    this.candidate = candidate.process;
    let committed = false;
    try {
      const launch: RuntimeLaunch = {
        provenance: this.options.provenance,
        version: this.options.version,
        control: this.options.control,
        workspace: this.workspace || undefined,
        nativeStateDir: this.options.stateDir,
      };
      const info = await candidate.process.request<CandidateInfo>("preflight", launch);
      this.assertOpen();
      if (this.workspace && info.workspace !== this.workspace)
        throw new Error("Candidate changed pinned workspace");
      this.workspace = info.workspace;
      if (operation) this.stage(operation, "quiescing");
      // Only successful preflight may touch the current call, mute holds, or incarnation.
      this.cancelHolds();
      this.active?.notify("mute", { mic: true, speaker: true });
      this.activeIncarnation = 0;
      this.mailbox.unavailableRuntime();
      this.phase = "quiescing";
      this.voice = { ...this.voice, phase: "waiting-ready" };
      committed = true;
      if (operation) this.generation++;
      this.changed();
      const forced = (await this.active?.stop()) ?? false;
      this.active = undefined;
      if (operation) {
        operation.forced = forced;
        this.stage(operation, forced ? "forced" : "interrupted");
      }
      this.assertOpen();
      this.active = candidate.process;
      this.activeIncarnation = candidate.incarnation;
      this.candidate = undefined;
      this.buildId = info.buildId;
      this.phase = "starting";
      if (operation) this.stage(operation, "starting");
      await candidate.process.request(
        "activate",
        {
          threadId: handoffTarget?.threadId ?? (this.threadId || undefined),
          mute: { mic: this.microphone.muted, speaker: this.speaker.muted },
        },
        90_000,
      );
      this.assertOpen();
      if (
        handoffTarget &&
        (this.threadId !== handoffTarget.threadId || this.workspace !== handoffTarget.workspace)
      )
        throw new Error("Restart did not restore the handoff's original conversation");
      await candidate.process.request("enable-media", {
        mic: this.microphone.muted,
        speaker: this.speaker.muted,
      });
      this.assertOpen();
      if (this.phase === "failed")
        throw new Error(this.voice.notice ?? "Runtime failed during activation");
      this.phase = "ready";
      this.syncMute();
      if (operation) this.stage(operation, "ready");
      this.changed();
    } catch (error) {
      await candidate.process.stop();
      if (this.candidate === candidate.process) this.candidate = undefined;
      if (committed) {
        if (this.active === candidate.process) this.active = undefined;
        this.phase = "failed";
        this.voice.phase = "failed";
      }
      throw error;
    }
  }
  private stage(operation: JournalOperation, phase: ControlOperationPhase) {
    if (phase === "ready")
      operation.result = {
        generation: this.generation,
        threadId: this.threadId,
        workspace: this.workspace,
        pid: this.active?.pid,
        buildId: this.buildId,
      };
    operation.phase = phase;
    operation.updatedAt = new Date().toISOString();
    this.journal.save(operation);
    this.operation = publicOperation(operation);
    this.changed();
  }
  restart(request: ControlRestartRequest) {
    if (
      request.handoffPrompt !== undefined &&
      !handoffPromptSchema.safeParse(request.handoffPrompt).success
    )
      return Promise.reject(
        new ControlError(
          "invalid_params",
          "handoffPrompt must contain text within 8192 UTF-8 bytes",
        ),
      );
    return this.accept("restart", request);
  }
  redial(request: ControlMutationRequest) {
    return this.accept("redial", request);
  }
  private async accept(
    kind: "restart" | "redial",
    request: ControlMutationRequest & { handoffPrompt?: string },
  ): Promise<ControlOperation> {
    if (kind === "redial" && request.handoffPrompt !== undefined)
      throw new ControlError(
        "invalid_params",
        "handoffPrompt is supported only by runtime restart",
      );
    if (request.expectedInstanceId !== this.options.instanceId)
      throw new ControlError("instance_mismatch", "Control request targets another controller");
    const prior = this.journal.get(request.operationId);
    if (prior) {
      if (
        prior.kind !== kind ||
        prior.expectedGeneration !== request.expectedGeneration ||
        prior.expectedInstanceId !== request.expectedInstanceId ||
        prior.handoffPayload?.prompt !== request.handoffPrompt
      )
        throw new ControlError(
          "operation_conflict",
          "Operation ID already names a different immutable request",
        );
      return publicOperation(prior);
    }
    if (request.expectedGeneration !== this.generation)
      throw new ControlError(
        "stale_generation",
        "Read status before mutating the current runtime generation",
      );
    if (this.closed || this.busy)
      throw new ControlError(
        "unavailable",
        "Controller mutation already in progress or shutting down",
      );
    if (kind === "redial" && this.phase !== "ready")
      throw new ControlError("unavailable", "Runtime is not ready for redial");
    if (request.handoffPrompt !== undefined && (!this.threadId || !this.workspace))
      throw new ControlError("unavailable", "A handoff requires an established conversation");
    const now = new Date().toISOString();
    const operation: JournalOperation = {
      operationId: request.operationId,
      expectedGeneration: request.expectedGeneration,
      expectedInstanceId: request.expectedInstanceId,
      kind,
      scope: kind === "restart" ? "runtime" : "voice",
      phase: "accepted",
      acceptedAt: now,
      updatedAt: now,
      ...(request.handoffPrompt === undefined
        ? {}
        : {
            handoffPayload: {
              prompt: request.handoffPrompt,
              threadId: this.threadId,
              workspace: this.workspace,
            },
            handoff: { status: "pending" as const, clientUserMessageId: randomUUID() },
          }),
    };
    this.journal.save(operation);
    this.operation = publicOperation(operation);
    this.busy = true;
    // Return the durable acceptance before self-restart quiesces its native caller.
    this.background = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(async () => {
      try {
        this.assertOpen();
        if (kind === "restart") await this.replace(operation);
        else {
          this.stage(operation, "starting");
          await this.active!.request("redial", {}, 35_000);
          this.stage(operation, "ready");
        }
      } catch (error) {
        if (operation.handoff?.status === "pending")
          operation.handoff = { ...operation.handoff, ...handoffFailure("not_ready") };
        operation.error = { code: "runtime_failed", message: String(error) };
        try {
          this.stage(operation, "failed");
        } catch {
          this.notice("Operation journal update failed; status may not have been durably recorded");
        }
        this.notice(`${kind} failed: ${String(error)}`);
      } finally {
        // Optional task delivery must never enter replace()'s runtime teardown path.
        if (operation.phase === "ready" && operation.handoff?.status === "pending")
          await this.deliverHandoff(operation);
        this.busy = false;
        this.changed();
      }
    });
    this.changed();
    return publicOperation(operation);
  }
  private async deliverHandoff(operation: JournalOperation): Promise<void> {
    const payload = operation.handoffPayload;
    const handoff = operation.handoff;
    if (!payload || !handoff || handoff.status !== "pending") return;
    const runtime = this.active;
    let outcome = handoffFailure("not_ready");
    if (
      !this.closed &&
      this.phase === "ready" &&
      runtime &&
      this.generation === operation.expectedGeneration + 1 &&
      this.threadId === payload.threadId &&
      this.workspace === payload.workspace
    ) {
      operation.handoff = { ...handoff, status: "submitting" };
      try {
        this.stage(operation, "ready");
      } catch {
        this.finishHandoff(operation, handoffFailure("journal_failed"));
        return;
      }
      if (
        this.closed ||
        this.phase !== "ready" ||
        this.active !== runtime ||
        this.threadId !== payload.threadId ||
        this.workspace !== payload.workspace
      ) {
        this.finishHandoff(operation, handoffFailure("not_ready"));
        return;
      }
      // No await separates identity checks and dispatch after the journal write.
      try {
        const response = await runtime.request(
          "handoff",
          {
            ...payload,
            clientUserMessageId: handoff.clientUserMessageId,
          },
          12_000,
        );
        const checked = handoffResultSchema.safeParse(response);
        const result = checked.success ? checked.data : handoffUnknown();
        if (result.status === "accepted") outcome = result;
        else if (
          result.status === "failed" &&
          (result.error.code === "not_ready" || result.error.code === "native_refused")
        )
          outcome = handoffFailure(result.error.code);
        else outcome = handoffUnknown();
      } catch {
        outcome = handoffUnknown();
      }
    }
    this.finishHandoff(operation, outcome);
  }
  private async submitMailboxWake(eventId: string) {
    const runtime = this.active;
    const generation = this.generation;
    const incarnation = this.activeIncarnation;
    if (this.closed || !runtime || !this.threadId || !["ready", "starting"].includes(this.phase)) {
      this.mailbox.outcome(eventId, generation, { status: "unavailable" });
      return;
    }
    const request = {
      eventId,
      instanceId: this.options.instanceId,
      rootThreadId: this.threadId,
      completed: this.mailbox.snapshot().completed,
    };
    let outcome: WakeOutcome;
    try {
      outcome = wakeOutcomeSchema.parse(await runtime.request("mailbox-wake", request, 12000));
    } catch {
      outcome = { status: "unknown" as const };
    }
    if (this.closed || this.activeIncarnation !== incarnation || this.active !== runtime) return;
    this.mailbox.outcome(eventId, generation, outcome);
  }
  async mailboxOpen(
    request: MailboxOpenParams,
    caller?: MailboxCaller,
  ): Promise<MailboxOpenResult> {
    const params = mailboxOpenParams.parse(request);
    if (params.expectedInstanceId !== this.options.instanceId)
      throw new ControlError("instance_mismatch", "Mailbox belongs to another call");
    if (this.closed || !this.threadId)
      throw new ControlError("unavailable", "Mailbox is unavailable");
    const runtime = this.active,
      incarnation = this.activeIncarnation;
    if (caller) {
      if (
        caller.threadId !== this.threadId ||
        !runtime ||
        this.phase !== "ready" ||
        !(await runtime.request<boolean>("mailbox-authorize", caller, 2000))
      )
        throw new ControlError(
          "invalid_request",
          "Only the orchestrator may open its mailbox through a native tool call",
        );
    }
    const current = () =>
      !this.closed && runtime === this.active && incarnation === this.activeIncarnation;
    if (!current()) throw new ControlError("unavailable", "Mailbox runtime changed");
    const cached = this.mailbox.cached(params.operationId);
    if (cached) return cached;
    if (runtime && ["ready", "starting"].includes(this.phase)) {
      try {
        const inventory = inFlightSchema.parse(await runtime.request("mailbox-snapshot", {}, 2000));
        if (!current()) throw new Error("changed");
        this.mailbox.update(inventory);
      } catch {
        if (!current()) throw new ControlError("unavailable", "Mailbox runtime changed");
        this.mailbox.gap("inventory");
      }
    }
    if (!current()) throw new ControlError("unavailable", "Mailbox runtime changed");
    return this.mailbox.open(params.operationId);
  }
  private finishHandoff(operation: JournalOperation, outcome: HandoffResult) {
    operation.handoff = { clientUserMessageId: operation.handoff!.clientUserMessageId, ...outcome };
    operation.updatedAt = new Date().toISOString();
    this.operation = publicOperation(operation);
    try {
      this.journal.save(operation);
    } catch {
      this.notice("Handoff status could not be journaled; it will not be retried automatically");
    }
    this.changed();
  }
  private cancelHolds() {
    this.microphone.releaseUnmute("frontend");
    this.speaker.releaseUnmute("frontend");
  }
  syncMute() {
    if (this.phase === "ready" || this.phase === "starting")
      this.active?.notify("mute", {
        mic: this.microphone.effectiveMuted,
        speaker: this.speaker.effectiveMuted,
      });
    this.changed();
  }
  async readConversation(method: ConversationReadMethod, params: ConversationReadParams) {
    const parsed = conversationRequestSchemas[method].safeParse(params);
    if (!parsed.success) throw new ObservationError("invalid_params");
    if (params.expectedInstanceId !== this.options.instanceId)
      throw new ObservationError("instance_mismatch");
    if (params.expectedGeneration !== this.generation)
      throw new ObservationError("stale_generation");
    if (this.closed || this.phase !== "ready" || !this.active)
      throw new ObservationError("unavailable");
    if (!this.leases.has(params.rootThreadId)) throw new ObservationError("forbidden_thread");
    if (this.observationPending >= 4) throw new ObservationError("busy");
    const active = this.active;
    const incarnation = this.activeIncarnation;
    let value: { ok?: boolean; result?: unknown; error?: { code?: unknown } };
    this.observationPending++;
    try {
      value = await active.request(method, parsed.data, 8_000);
    } catch {
      throw new ObservationError("unavailable");
    } finally {
      this.observationPending--;
    }
    if (
      this.closed ||
      this.phase !== "ready" ||
      this.active !== active ||
      this.activeIncarnation !== incarnation ||
      this.generation !== params.expectedGeneration
    )
      throw new ObservationError("stale_generation");
    if (!value?.ok) {
      const code = observationErrorCode.safeParse(value?.error?.code);
      throw new ObservationError(code.success ? code.data : "unavailable");
    }
    const result = readResultSchema.safeParse(value.result);
    if (
      !result.success ||
      result.data.method !== method ||
      result.data.rootThreadId !== params.rootThreadId ||
      ("threadId" in result.data ? result.data.threadId : undefined) !==
        ("threadId" in params ? params.threadId : undefined)
    )
      throw new ObservationError("unsupported");
    if (method === "conversation.live.get" && "threadId" in params)
      return this.lifecycle.live(params.threadId);
    return { instanceId: this.options.instanceId, generation: this.generation, ...result.data };
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    // Publish only after the promise exists: changed callbacks may request shutdown too.
    this.shutdownPromise = Promise.resolve().then(async () => {
      this.phase = "stopping";
      this.changed();
      const stopped = await Promise.allSettled([this.active?.stop(), this.candidate?.stop()]);
      this.activeIncarnation = 0;
      if (stopped.some((result) => result.status === "rejected" || result.value === true)) {
        this.phase = "failed";
        this.notice("Call required forced cleanup; final voice transcript may be incomplete");
      }
      await this.background;
      for (const release of this.leases.values()) release();
      this.leases.clear();
      this.mailbox.clear();
      this.journal.close();
      const failed = stopped.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.shutdownPromise;
  }
}

export async function createCall(
  provenance: LaunchProvenance,
  version: string,
  changed: () => void,
): Promise<{ controller: RuntimeController; close(): Promise<void> }> {
  const instanceId = randomUUID();
  const stateDir = stateDirectory(process.env, homedir());
  let controller: RuntimeController | undefined;
  let control: ControlServer | undefined;
  const lifecycle = new LifecycleFeed(instanceId);
  const recording = recordCall(lifecycle, stateDir, console.error);
  const current = () => {
    if (!controller) throw new ControlError("unavailable", "Call is initializing");
    return controller;
  };
  const events = new EventSocketServer(
    eventSocketPath(stateDir, instanceId),
    lifecycle,
    (method, params) => current().readConversation(method, params),
  );
  const close = async () => {
    let failedShutdown = true;
    try {
      await controller?.shutdown();
      failedShutdown = false;
    } finally {
      recording.close(failedShutdown);
      events.close();
      await control?.close();
    }
  };
  try {
    await events.start();
    control = await startControlServer({
      backend: {
        status: () => current().status(),
        mailboxOpen: (params, caller) => current().mailboxOpen(params, caller),
        redial: (request) => current().redial(request),
        restart: (request) => current().restart(request),
      },
      stateDir,
      instanceId,
      attachment: (value) => current().attachmentTicket(value),
    });
    controller = new RuntimeController({
      instanceId,
      stateDir,
      lifecycle,
      provenance,
      version,
      changed,
      control: {
        name: CONTROL_MCP_SERVER_NAME,
        server: { ...control.mcpServer },
        tools: CONTROL_MCP_TOOLS,
        env: {
          [control.bearerTokenEnvVar]: control.bearerToken,
          [control.socketEnvVar]: control.socketPath,
          AGENTVOICE_EVENTS_SOCKET: events.path,
        },
      },
    });
    return { controller, close };
  } catch (error) {
    await close();
    throw error;
  }
}
