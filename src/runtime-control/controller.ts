/** Server-owned call authority. Media and UI remain in separate processes. */
import { randomInt, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachmentTargetSchema } from "../attachment/bootstrap.ts";
import type { AttachmentTicket } from "../attachment/gateway.ts";
import { MuteGate } from "../console/audio-control.ts";
import type { VoiceState } from "../console/state.ts";
import { voiceEditRecordSchema } from "../control/contract.ts";
import { startControlServer, voiceEditSchema } from "../control/index.ts";
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
  type VoiceGetResult,
  type VoiceSetRequest,
} from "../control/types.ts";
import type { ControlMcpRegistration } from "../core/control-mcp.ts";
import {
  type HandoffResult,
  handoffFailure,
  handoffPromptSchema,
  handoffResultSchema,
  handoffUnknown,
} from "../core/handoff.ts";
import {
  type DirectoryRoleInfo,
  directoryRoleInfoSchema,
  directoryRoleStatus,
  workspaceRoleSourceStatus,
} from "../core/role-content.ts";
import { clearSessionMarker, readSessionMarker } from "../core/session-marker.ts";
import { lockThread } from "../core/thread-lock.ts";
import { compatibleVoiceCatalog } from "../core/voice-catalog.ts";
import {
  type VoiceInspection,
  voiceInspectionSchema,
  voiceProtocol,
} from "../core/voice-inspection.ts";
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
  type ClientMediaMessage,
  clientMediaMessageSchema,
  type ServerMediaMessage,
  serverMediaMessageSchema,
} from "../frontend/media-protocol.ts";
import { dataDirectory, stateDirectory } from "../paths.ts";
import { recordCall } from "../recording/call.ts";
import {
  type RoleRef,
  readRoleHead,
  readVoiceReceipt,
  rolePath,
  roleRefSchema,
  type VoiceEdit,
  writeVoice,
} from "../roles/store.ts";
import { type CodingActivity, CodingActivityReducer } from "./coding-activity.ts";
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
  onMedia?(message: ServerMediaMessage): void;
  /** Server sessions may start without a media owner. Standalone fixtures default attached. */
  frontendAttached?: boolean;
  /** Deterministic boundary for random-selection tests. */
  chooseVoiceIndex?: (length: number) => number;
}

export class RuntimeController implements ControlBackend {
  readonly lifecycle: LifecycleFeed;
  private readonly journal: OperationJournal;
  private readonly coding = new CodingActivityReducer();
  private readonly leases = new Map<string, () => void>();
  private workspaceLease: (() => void) | undefined;
  private active: RuntimeProcess | undefined;
  private candidate: RuntimeProcess | undefined;
  private generation = 1;
  private incarnation = 0;
  private activeIncarnation = 0;
  private workspace = "";
  private threadId = "";
  private buildId: string | undefined;
  private loadedRole: RoleRef | undefined;
  private loadedAdoptionSource:
    | { info: DirectoryRoleInfo; generation: number; revision: number }
    | undefined;
  private loadedDirectoryRole: { info: DirectoryRoleInfo; generation: number } | undefined;
  private voiceRevision = 1;
  private loadedVoice: string | null = null;
  private voiceOutcomeUnknown = false;
  private phase = "starting";
  private nativeThreadReady = false;
  private operation: ControlOperation | undefined;
  private busy = false;
  private started = false;
  private observationPending = 0;
  private closed = false;
  private frontendAttached: boolean;
  private shutdownPromise: Promise<void> | undefined;
  private background: Promise<void> | undefined;
  private voice: VoiceState = {
    available: true,
    phase: "waiting-ready",
    mic: { muted: true, effectiveMuted: true },
    speaker: { muted: false, effectiveMuted: false },
  };
  readonly microphone = new MuteGate(true);
  readonly speaker = new MuteGate();

  constructor(private readonly options: ControllerOptions) {
    this.frontendAttached = options.frontendAttached ?? true;
    this.lifecycle = options.lifecycle ?? new LifecycleFeed(options.instanceId);
    this.journal = new OperationJournal(
      join(options.stateDir, "operations", `${options.instanceId}.jsonl`),
    );
  }
  status(): ControlStatus {
    let role: ControlStatus["role"];
    if (this.loadedRole) {
      role = {
        loaded: this.loadedRole,
        voiceRevision: this.voiceRevision,
        voice: this.loadedVoice,
        ...(this.loadedAdoptionSource
          ? {
              adoptionSource: workspaceRoleSourceStatus(
                this.loadedAdoptionSource.info,
                this.loadedAdoptionSource.generation,
                this.loadedAdoptionSource.revision,
              ),
            }
          : {}),
      };
      try {
        const desired = readRoleHead(this.roleDatabasePath());
        if (desired.ref.id !== this.loadedRole.id) throw new Error("Role identity changed");
        role.desired = desired.ref;
        role.desiredVoice = desired.voice;
      } catch {
        role.error = "Workspace role database is unavailable or its identity changed";
      }
    }
    return {
      ...(role ? { role } : {}),
      ...(this.loadedDirectoryRole
        ? {
            directoryRole: directoryRoleStatus(
              this.loadedDirectoryRole.info,
              this.loadedDirectoryRole.generation,
            ),
          }
        : {}),
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
        attachmentReady: this.canAttach(),
      },
      currentOperation: this.operation && structuredClone(this.operation),
      recentOperations: this.journal.all().slice(-16).map(publicOperation),
    };
  }
  private canAttach() {
    return (
      !this.closed &&
      (!this.busy || this.phase === "starting") &&
      ["starting", "ready"].includes(this.phase) &&
      this.nativeThreadReady &&
      !!this.active
    );
  }
  async attachmentTicket(value: unknown): Promise<AttachmentTicket> {
    const target = attachmentTargetSchema.parse(value);
    const current = () =>
      this.canAttach() &&
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
  state(): VoiceState & { codingActivity: CodingActivity } {
    const ready = this.phase === "ready";
    return {
      ...this.voice,
      codingActivity:
        !this.closed && ["starting", "ready"].includes(this.phase)
          ? this.coding.state()
          : "unknown",
      available: !this.closed,
      workspace: this.workspace,
      mic: {
        muted: this.microphone.muted,
        effectiveMuted: !ready || !this.frontendAttached || this.microphone.effectiveMuted,
      },
      speaker: {
        muted: this.speaker.muted,
        effectiveMuted: !ready || !this.frontendAttached || this.speaker.effectiveMuted,
      },
    };
  }
  private changed() {
    if (this.closed || !["starting", "ready"].includes(this.phase)) this.coding.reset();
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
    if (method === "client-media") {
      const parsed = serverMediaMessageSchema.safeParse(params);
      if (parsed.success && this.frontendAttached) this.options.onMedia?.(parsed.data);
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
      if (!["starting", "ready"].includes(this.phase)) return;
      const checked = threadInventorySchema.safeParse(params);
      if (checked.success) {
        this.lifecycle.update(checked.data);
        this.coding.threads(checked.data);
      } else {
        this.lifecycle.update({ threads: this.lifecycle.snapshot().threads, complete: false });
        this.coding.rootGap();
      }
      this.changed();
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
      this.coding.reset(identity.threadId);
      const snapshot = this.lifecycle.snapshot();
      this.coding.threads({ threads: snapshot.threads, complete: snapshot.inventory === "ready" });
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
        // currentReady is emitted only after native thread and control initialization.
        this.nativeThreadReady = true;
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
      if (info.role) roleRefSchema.parse(info.role);
      if (info.adoptionSource) directoryRoleInfoSchema.parse(info.adoptionSource);
      if (info.directoryRole) directoryRoleInfoSchema.parse(info.directoryRole);
      if (info.role && info.directoryRole)
        throw new Error("Candidate reported conflicting role sources");
      if (info.adoptionSource && !info.role)
        throw new Error("Candidate reported an adoption source without a workspace role");
      if (this.loadedRole && info.role?.id !== this.loadedRole.id)
        throw new Error("Candidate changed the bound workspace role");
      this.workspace = info.workspace;
      this.workspaceLease ??= lockThread(
        join(this.options.stateDir, "thread-locks", "workspaces"),
        this.workspace,
      );
      const newSession = operation?.kind === "new-session";
      const previousMarker = newSession ? readSessionMarker(this.workspace) : null;
      if (operation) this.stage(operation, "quiescing");
      // Only successful preflight may touch the current call, mute holds, or incarnation.
      this.cancelHolds();
      this.active?.notify("mute", { mic: true, speaker: true });
      this.activeIncarnation = 0;
      this.nativeThreadReady = false;
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
      if (newSession) {
        clearSessionMarker(this.workspace, previousMarker);
        this.threadId = "";
        this.voice.conversation = undefined;
        this.coding.reset();
      }
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
          frontendAttached: this.frontendAttached,
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
      this.loadedRole = info.role;
      this.loadedAdoptionSource =
        info.role && info.adoptionSource
          ? {
              info: structuredClone(info.adoptionSource),
              generation: this.generation,
              revision: info.role.revision,
            }
          : undefined;
      this.loadedDirectoryRole = info.directoryRole
        ? { info: structuredClone(info.directoryRole), generation: this.generation }
        : undefined;
      this.voiceRevision = info.role?.revision ?? 1;
      this.loadedVoice = info.voice ?? null;
      this.voiceOutcomeUnknown = false;
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
  newSession(request: ControlMutationRequest) {
    return this.accept("new-session", request);
  }
  private roleDatabasePath(): string {
    return rolePath(dataDirectory(process.env, homedir()), this.workspace);
  }

  private async inspectVoice(refresh = false): Promise<VoiceInspection> {
    const active = this.active;
    if (!active || this.closed || this.phase !== "ready")
      throw new ControlError("unavailable", "Voice inspection requires a ready runtime");
    const inspection = voiceInspectionSchema.parse(
      await active.request("voice-inspect", { refresh }, 3000),
    );
    if (active !== this.active || this.closed)
      throw new ControlError("unavailable", "Runtime changed during voice inspection; read again");
    if (!this.frontendAttached || this.voice.phase !== "live" || this.voiceOutcomeUnknown)
      return { ...inspection, requestedVoice: null, selectionSource: "unknown" };
    return inspection;
  }

  async voiceGet(request: { refresh?: boolean } = {}): Promise<VoiceGetResult> {
    const inspection = await this.inspectVoice(request.refresh);
    const status = this.status();
    const editError = !this.loadedRole
      ? "Workspace role has not been ejected"
      : status.role?.error
        ? status.role.error
        : inspection.masked
          ? "Raw voice.extra.voice masks the managed selection"
          : this.busy
            ? "Another control operation is in progress"
            : undefined;
    return {
      instanceId: this.options.instanceId,
      generation: this.generation,
      workspace: this.workspace,
      threadId: this.threadId,
      ...(this.active?.nativePid ? { nativePid: this.active.nativePid } : {}),
      phase: this.voice.phase,
      editable: editError === undefined,
      canApplyNow: editError === undefined && this.frontendAttached,
      ...(editError ? { editError } : {}),
      inspection,
      ...(status.role ? { role: status.role } : {}),
    };
  }

  async voiceSet(input: VoiceSetRequest): Promise<ControlOperation> {
    const checked = voiceEditSchema.safeParse(input);
    if (!checked.success) throw new ControlError("invalid_params", "Invalid voice edit");
    const request: VoiceSetRequest = checked.data;
    if (request.expectedInstanceId !== this.options.instanceId)
      throw new ControlError("instance_mismatch", "Control request targets another controller");
    const prior = this.journal.get(request.operationId);
    if (prior) {
      const edit = prior.voiceEdit;
      if (!edit || !sameVoiceRequest(request, edit))
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
    if (!this.loadedRole || !this.active || this.closed || this.busy || this.phase !== "ready")
      throw new ControlError(
        "unavailable",
        "Voice editing requires a ready call with an ejected workspace role",
      );
    if (request.apply === "voice" && !this.frontendAttached)
      throw new ControlError(
        "unavailable",
        "Voice application requires an attached frontend; save for restart instead",
      );
    if (this.journal.all().length >= 256)
      throw new ControlError(
        "unavailable",
        "Controller operation limit reached; restart the server",
      );
    this.busy = true;
    const active = this.active;
    let operation: JournalOperation;
    let resolved: VoiceEdit;
    try {
      const path = this.roleDatabasePath();
      const receipt = readVoiceReceipt(
        path,
        this.loadedRole.id,
        request.expectedInstanceId,
        request.operationId,
      );
      if (receipt) {
        resolved = voiceEditRecordSchema.parse(receipt.edit);
        if (!sameVoiceRequest(request, resolved))
          throw new Error("Operation ID names a different role edit");
      } else {
        const desired = readRoleHead(path);
        if (desired.ref.id !== this.loadedRole.id) throw new Error("Role identity changed");
        if (desired.ref.revision !== request.expectedRoleRevision)
          throw new Error("Stale role revision; read voice_get before editing");
        if (Object.hasOwn(desired.voiceSettings.extra ?? {}, "voice"))
          throw new Error("Raw voice.extra.voice masks the managed voice selection");
        const inspection = await this.inspectVoice();
        if (inspection.masked)
          throw new Error("Raw voice.extra.voice masks the managed voice selection");
        const protocol =
          request.apply === "voice" ? inspection.protocol : voiceProtocol(desired.voiceSettings);
        const compatible = compatibleVoiceCatalog(inspection.catalog, protocol);
        let name: string | null;
        if (request.selection) {
          if (
            inspection.selectionSource !== "explicit-request" ||
            inspection.requestedVoice === null
          )
            throw new Error(
              "Current effective voice is unknown; random-different cannot be guaranteed",
            );
          if (inspection.catalog.status !== "available")
            throw new Error("Native voice catalog is unavailable");
          if (protocol === null)
            throw new Error("Cannot validate voices for this realtime transport/protocol");
          const candidates = compatible.choices.filter(
            (voice) => voice !== inspection.requestedVoice,
          );
          if (!candidates.length) throw new Error("No different compatible voice is available");
          const index = (this.options.chooseVoiceIndex ?? randomInt)(candidates.length);
          if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length)
            throw new Error("Invalid random voice choice");
          name = candidates[index]!;
        } else name = request.voice;
        if (name !== null) {
          if (inspection.catalog.status !== "available")
            throw new Error("Native voice catalog is unavailable");
          if (protocol === null)
            throw new Error("Cannot validate voices for this realtime transport/protocol");
          if (!compatible.choices.includes(name))
            throw new Error("Voice is not supported by this native runtime/protocol");
        }
        resolved = {
          ...request,
          voice: name,
          ...(name !== null && inspection.catalog.status === "available" && protocol !== null
            ? {
                catalog: {
                  source: inspection.catalog.source,
                  fetchedAt: inspection.catalog.fetchedAt,
                  protocol,
                },
              }
            : {}),
        };
      }
      if (request.apply === "voice") await active.request("voice-validate", resolved.voice, 3000);
      this.assertOpen();
      if (active !== this.active) throw new Error("Voice runtime changed before save");
      const saved = writeVoice(path, this.loadedRole.id, resolved);
      const now = new Date().toISOString();
      operation = {
        operationId: request.operationId,
        expectedInstanceId: request.expectedInstanceId,
        expectedGeneration: request.expectedGeneration,
        kind: "voice-set",
        scope: "voice",
        phase: "accepted",
        acceptedAt: now,
        updatedAt: now,
        voiceEdit: {
          ...resolved,
          saved,
          application: request.apply === "voice" ? "pending" : "deferred",
        },
      };
      try {
        this.journal.save(operation);
      } catch {
        throw new Error(
          `Voice saved at revision ${saved.revision}, but application was not started because journaling failed`,
        );
      }
      this.operation = publicOperation(operation);
    } catch (error) {
      this.busy = false;
      this.changed();
      throw new ControlError("invalid_request", String(error));
    }
    this.background = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(async () => {
      let dispatched = false;
      try {
        this.assertOpen();
        if (request.apply === "voice") {
          this.cancelHolds();
          this.syncMute();
          this.stage(operation, "starting");
          dispatched = true;
          const result = await active.request<{ applied?: boolean }>(
            "voice-apply",
            resolved.voice,
            35_000,
          );
          if (result?.applied !== true) throw new Error("Voice application was not confirmed");
          this.assertOpen();
          if (this.active !== active) throw new Error("Voice runtime changed during application");
          this.loadedVoice = resolved.voice;
          this.voiceOutcomeUnknown = false;
          this.voiceRevision = operation.voiceEdit!.saved.revision;
          operation.voiceEdit!.application = "applied";
        }
        this.stage(operation, "ready");
      } catch (error) {
        const applied = operation.voiceEdit!.application === "applied";
        if (!applied)
          operation.voiceEdit!.application =
            request.apply !== "voice" ? "deferred" : dispatched ? "unknown" : "failed";
        if (operation.voiceEdit!.application === "unknown") this.voiceOutcomeUnknown = true;
        operation.error = {
          code: applied ? "journal_failed" : "voice_apply_failed",
          message: String(error),
        };
        try {
          this.stage(operation, "failed");
        } catch {
          this.notice("Voice edit saved; application journal update failed");
        }
        this.notice(
          applied
            ? "Voice changed, but recording its application outcome failed"
            : "Voice selection saved but application did not complete; inspect status and retry explicitly",
        );
      } finally {
        this.busy = false;
        this.changed();
      }
    });
    this.changed();
    return publicOperation(operation);
  }
  redial(request: ControlMutationRequest) {
    return this.accept("redial", request);
  }
  private async accept(
    kind: "restart" | "redial" | "new-session",
    request: ControlMutationRequest & { handoffPrompt?: string },
  ): Promise<ControlOperation> {
    if (kind !== "restart" && request.handoffPrompt !== undefined)
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
    if (kind === "redial" && (this.phase !== "ready" || !this.frontendAttached))
      throw new ControlError(
        "unavailable",
        "Redial requires an attached frontend and ready runtime",
      );
    if (request.handoffPrompt !== undefined && (!this.threadId || !this.workspace))
      throw new ControlError("unavailable", "A handoff requires an established conversation");
    const now = new Date().toISOString();
    const operation: JournalOperation = {
      operationId: request.operationId,
      expectedGeneration: request.expectedGeneration,
      expectedInstanceId: request.expectedInstanceId,
      kind,
      scope: kind === "redial" ? "voice" : "runtime",
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
        if (kind !== "redial") await this.replace(operation);
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
  async setFrontendAttached(attached: boolean): Promise<void> {
    this.assertOpen();
    this.frontendAttached = attached;
    if (!attached) this.cancelHolds();
    this.syncMute();
    // Desired attachment state also initializes any replacement candidate. A stopped
    // incarnation cannot fail detachment of its successor or poison server admission.
    const runtime = this.active;
    const incarnation = this.activeIncarnation;
    if (runtime && incarnation !== 0) {
      try {
        await runtime.request("frontend", { attached }, 12_000);
      } catch (error) {
        if (!this.closed && this.active === runtime && this.activeIncarnation === incarnation)
          throw error;
      }
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
        mic: !this.frontendAttached || this.microphone.effectiveMuted,
        speaker: !this.frontendAttached || this.speaker.effectiveMuted,
      });
    this.changed();
  }
  clientMedia(message: ClientMediaMessage): void {
    if (this.closed || !this.active || !this.frontendAttached) return;
    const parsed = clientMediaMessageSchema.safeParse(message);
    if (!parsed.success) return;
    this.active.notify("client-media", parsed.data);
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
    if (params.rootThreadId !== this.threadId || !this.leases.has(params.rootThreadId))
      throw new ObservationError("forbidden_thread");
    // The root live view is already a controller-owned, generation-scoped projection.
    // Its identity and lease were verified above, so asking the disposable worker to
    // authorize the same read only consumes scarce observation capacity and the
    // worker result is discarded below. Descendant views still go through native
    // ancestry authorization before the projection is returned.
    if (
      method === "conversation.live.get" &&
      "threadId" in params &&
      params.threadId === this.threadId
    )
      return this.lifecycle.live(params.threadId);
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
      this.workspaceLease?.();
      this.workspaceLease = undefined;
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
  options: {
    onMedia?(message: ServerMediaMessage): void;
    /** Server sessions may start without a media owner. Standalone fixtures default attached. */
    frontendAttached?: boolean;
  } = {},
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
        redial: (request) => current().redial(request),
        restart: (request) => current().restart(request),
        newSession: (request) => current().newSession(request),
        voiceSet: (request) => current().voiceSet(request),
        voiceGet: (request) => current().voiceGet(request),
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
      ...options,
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

/** Selection intent is immutable; a random operation's concrete voice is output, not new input. */
function sameVoiceRequest(request: VoiceSetRequest, edit: VoiceEdit): boolean {
  return (
    request.operationId === edit.operationId &&
    request.expectedInstanceId === edit.expectedInstanceId &&
    request.expectedGeneration === edit.expectedGeneration &&
    request.expectedRoleRevision === edit.expectedRoleRevision &&
    request.apply === edit.apply &&
    (request.selection
      ? edit.selection?.kind === "random" && edit.selection.excludeCurrent === true
      : edit.selection === undefined && request.voice === edit.voice)
  );
}
