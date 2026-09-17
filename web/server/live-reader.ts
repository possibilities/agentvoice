import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { observeAttachmentServer, VoiceRecordingTail } from "../../src/attachment/session.ts";
import {
  discoverControllerStatus,
  type ReadableControlProtocol,
} from "../../src/control/discovery.ts";
import { CONTROL_PROTOCOL_VERSION } from "../../src/control/types.ts";
import { EVENT_PROTOCOL_VERSION } from "../../src/events/contract.ts";
import { conversationTurnSchema, readResultSchema } from "../../src/events/conversation.ts";
import { liveSnapshotSchema } from "../../src/events/conversation-projection.ts";
import { eventSnapshotSchema } from "../../src/events/schema.ts";
import { eventSocketPath } from "../../src/events/socket.ts";
import { ControlSocket, SocketFailure } from "../../src/ipc/control-client.ts";
import { savedRecordings } from "../../src/recording/store.ts";
import type { LiveView } from "../src/types.ts";
import { type AgentCommand, AgentControls } from "./agent-controls.ts";
import { sendAgentOperation } from "./agent-sender.ts";
import type { DocumentViewContext } from "./document-reader.ts";
import {
  type AgentItem,
  agentMessage,
  itemKey,
  VoiceMessages,
  voiceDelegationInput,
} from "./messages.ts";

const liveSchema = liveSnapshotSchema.extend({ instanceId: z.string(), generation: z.number() });
const historySchema = readResultSchema.options[4]!.extend({
  instanceId: z.string(),
  generation: z.number(),
});
const turnsSchema = readResultSchema.options[3]!.extend({
  instanceId: z.string(),
  generation: z.number(),
});
const empty = (phase: LiveView["phase"]): LiveView => ({ phase, id: phase, voice: [], agent: [] });
const DIAGNOSTIC_BYTES = 256 * 1024;
const DIAGNOSTIC_RATE_MS = 5_000;
const DIAGNOSTIC_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EACCES",
  "EPERM",
  "invalid_params",
  "unavailable",
  "stale_generation",
  "instance_mismatch",
  "forbidden_thread",
  "unsupported",
  "history_unavailable",
  "busy",
  "oversized",
  "cursor_expired",
  "resync_required",
  "internal_error",
]);
type ReaderStage =
  | "observer.connect"
  | "observer.closed"
  | "observer.identity"
  | "controller.discover"
  | "controller.identity"
  | "events.connect"
  | "events.subscribe"
  | "events.closed"
  | "events.snapshot"
  | "conversation.live"
  | "conversation.turns"
  | "history.connect"
  | "history.page"
  | "history.closed"
  | "voice.tail";

function persistenceScope(workspace: string, threadId: string) {
  return createHash("sha256").update(workspace).update("\0").update(threadId).digest("hex");
}

function systemErrorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
}

function diagnosticError(error: unknown) {
  const code = systemErrorCode(error);
  if (code && DIAGNOSTIC_CODES.has(code)) return code;
  if (code) return "system_error";
  if (error instanceof SocketFailure && /timed out/iu.test(error.message)) return "timeout";
  if (error instanceof Error && /timed out/iu.test(error.message)) return "timeout";
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid_response";
  if (error instanceof Error) {
    const fixed = [
      [/Oversized socket frame/iu, "oversized_frame"],
      [/Uncorrelated socket response/iu, "uncorrelated_response"],
      [/Incompatible socket protocol/iu, "incompatible_protocol"],
      [/Socket write limit exceeded/iu, "write_limit"],
      [/(?:socket|server).*(?:closed|disconnected|connection failed)/iu, "disconnected"],
      [/Unsafe (?:control )?socket/iu, "unsafe_transport"],
      [/Unsupported controller protocol/iu, "unsupported_protocol"],
      [/no live AgentVoice controller/iu, "controller_unavailable"],
      [/(?:Call|History attempt) changed/iu, "stale_attempt"],
    ] as const;
    for (const [pattern, reason] of fixed) if (pattern.test(error.message)) return reason;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(error.name)
    ? error.name
    : "unknown";
}
type Observer = Awaited<ReturnType<typeof observeAttachmentServer>>;
type Identity = {
  workspace: string;
  threadId: string;
  instanceId: string;
  generation: number;
  controlProtocolVersion: ReadableControlProtocol;
};
export type LocalImageViewContext = {
  viewId: string;
  workspace: string;
  threadId: string;
  current: () => boolean;
};
type HistoryPass = { rows: AgentItem[]; cursor?: string; bytes: number; revision: number };
type HistoryAttempt = { client?: ControlSocket; closed?: boolean };
type ControlTurn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
};

function controlTurn(
  root: { status: string; turn: ControlTurn | null } | undefined,
  observed: readonly ControlTurn[],
): ControlTurn | undefined {
  const current = root?.turn ?? undefined;
  if (root?.status !== "systemError") return current;
  const latest = observed.at(-1);
  // Native app-server keeps systemError as a non-running state until the next
  // turn. Its thread inventory can briefly retain the prior in-progress turn,
  // so prefer the matching terminal conversation event when it is available.
  if (
    current?.status === "inProgress" &&
    latest?.id === current.id &&
    latest.status !== "inProgress"
  )
    return latest;
  // Without the inventory's turn id there is no exact evidence that an older
  // failed event belongs to this systemError transition.
  return current;
}

function inputAvailable(root: { status: string } | undefined, turn: ControlTurn | undefined) {
  return (
    root?.status === "idle" ||
    (root?.status === "active" && turn?.status === "inProgress") ||
    (root?.status === "systemError" && turn?.status === "failed")
  );
}

/** Host-selected workspace adapter. The browser can neither choose sockets nor submit RPC methods. */
export class LiveReader {
  private observer?: Observer;
  private eventClient?: ControlSocket;
  private verifiedClient?: ControlSocket;
  private historyClient?: ControlSocket;
  private historyConnectPending?: Promise<ControlSocket>;
  private identity?: Identity;
  private viewId = "";
  private tail?: VoiceRecordingTail;
  private voice = new VoiceMessages();
  private history: AgentItem[] = [];
  private lifecycle = new Map<string, AgentItem>();
  private agentOrder: string[] = [];
  private pass?: HistoryPass;
  private historyRevision = 0;
  private loadedRevision = -1;
  private initialHistorySettled = false;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyRetryTimer?: ReturnType<typeof setTimeout>;
  private historyRetryAt = 0;
  // A failed or timed-out pass must remain eligible even if its snapshot is empty.
  // Otherwise its revision looks loaded and a newly opened reader stays truncated forever.
  private historyRefreshNeeded = false;
  private historyPending = false;
  private historyAttempt?: HistoryAttempt;
  private historyNotice?: string;
  private closed = false;
  private pending?: Promise<LiveView>;
  private cached = empty("connecting");
  private readAt = 0;
  private retryAt = 0;
  private retryDelay = 250;
  private stage: ReaderStage = "observer.connect";
  private readonly diagnosticAt = new Map<string, number>();
  private readonly controls: AgentControls;

  constructor(
    private readonly stateDir: string,
    private readonly initialHistoryBudgetMs = 5_000,
    private readonly historyRetryMs = 5_000,
    private readonly workspace?: string,
  ) {
    this.controls = new AgentControls(
      stateDir,
      (target, operation, current) =>
        sendAgentOperation(
          stateDir,
          target,
          operation,
          () => current() && !!this.identity && this.actionable(this.identity),
        ),
      workspace,
    );
  }

  async agentCommand(command: AgentCommand) {
    await this.read();
    if (!this.identity || !this.actionable(this.identity))
      throw new Error("The call changed. Nothing was sent.");
    await this.controls.command(command);
    this.readAt = 0;
  }

  /** A document grant can only be derived from the currently verified transcript incarnation. */
  async documentContext(): Promise<DocumentViewContext | undefined> {
    const view = await this.read();
    const identity = this.identity;
    const viewId = this.viewId;
    if (!identity || !viewId || view.id !== viewId || !this.current(identity)) return;
    return {
      viewId,
      workspace: identity.workspace,
      assistantMarkdown: view.agent
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
      current: () => this.identity === identity && this.viewId === viewId && this.current(identity),
    };
  }

  /** Clipboard bytes may only bind to the exact verified view that can submit Agent input. */
  async localImageContext(): Promise<LocalImageViewContext | undefined> {
    const view = await this.read();
    const identity = this.identity;
    const viewId = this.viewId;
    if (
      !identity ||
      !viewId ||
      view.id !== viewId ||
      !this.current(identity) ||
      !this.actionable(identity)
    )
      return;
    return {
      viewId,
      workspace: identity.workspace,
      threadId: identity.threadId,
      current: () =>
        this.identity === identity &&
        this.viewId === viewId &&
        this.current(identity) &&
        this.actionable(identity),
    };
  }

  read(): Promise<LiveView> {
    if (this.closed) return Promise.resolve(empty("offline"));
    if (this.pending) return this.pending;
    if (Date.now() < this.retryAt) {
      if (this.identity && this.observedReplacement(this.identity)) {
        this.resetCall();
        this.retryAt = 0;
      } else return Promise.resolve(this.cached);
    }
    if (Date.now() - this.readAt < 250) return Promise.resolve(this.cached);
    this.pending = this.update()
      .then((view) => {
        if (view.phase === "live" || view.phase === "detached" || view.phase === "empty") {
          this.retryAt = 0;
          this.retryDelay = 250;
        }
        return view;
      })
      .catch((error) => {
        this.diagnose(this.stage, error);
        if (this.recoverableCapacityPressure(error)) {
          this.scheduleRetry();
          return this.catchingUp();
        }
        if (
          this.replacementFailure(error) ||
          (this.identity && this.observedReplacement(this.identity))
        )
          this.resetCall();
        else this.disconnectLive();
        this.scheduleRetry();
        return this.retained("unavailable", "Agent transcript unavailable. Reconnecting…");
      })
      .then((view) => {
        this.cached = view;
        this.readAt = Date.now();
        return view;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private disconnectLive() {
    this.controls.disconnect();
    this.eventClient?.close();
    this.eventClient = undefined;
    this.verifiedClient = undefined;
    this.historyClient?.close();
    this.historyClient = undefined;
    this.historyConnectPending = undefined;
    this.pass = undefined;
    this.historyRevision++;
    this.loadedRevision = -1;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    clearTimeout(this.historyRetryTimer);
    this.historyRetryTimer = undefined;
    this.historyRetryAt = 0;
    this.historyRefreshNeeded = false;
    this.historyPending = false;
    this.historyAttempt = undefined;
    this.readAt = 0;
  }

  private scheduleRetry() {
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
  }

  private resetCall() {
    this.disconnectLive();
    this.identity = undefined;
    this.viewId = "";
    this.tail?.close();
    this.tail = undefined;
    this.voice = new VoiceMessages();
    this.history = [];
    this.lifecycle.clear();
    this.agentOrder = [];
    this.historyRevision = 0;
    this.loadedRevision = -1;
    this.initialHistorySettled = false;
    this.historyNotice = undefined;
    this.cached = empty("connecting");
  }

  close() {
    this.closed = true;
    this.resetCall();
    this.observer?.socket.close();
    this.observer = undefined;
  }

  private current(identity: Identity) {
    const state = this.observer?.latest();
    return (
      !this.closed &&
      this.identity === identity &&
      !!state &&
      state.workspace === identity.workspace &&
      state.threadId === identity.threadId &&
      (state.generation === undefined || state.generation === identity.generation)
    );
  }

  private observedReplacement(identity: Identity) {
    const state = this.observer?.latest();
    if (!state) return false;
    if (!state.workspace || !state.threadId) return state.availability === "idle";
    return (
      state.workspace !== identity.workspace ||
      state.threadId !== identity.threadId ||
      (state.generation !== undefined && state.generation !== identity.generation)
    );
  }

  private attached(identity: Identity) {
    const state = this.observer?.latest();
    return this.current(identity) && state?.availability === "connected" && !!state.clientId;
  }

  private actionable(identity: Identity) {
    const state = this.observer?.latest();
    return (
      this.eventClient !== undefined &&
      this.verifiedClient === this.eventClient &&
      state?.availability !== "unavailable" &&
      this.current(identity)
    );
  }

  private recoverableCapacityPressure(error: unknown) {
    return (
      this.stage === "conversation.live" &&
      error instanceof SocketFailure &&
      error.code === "busy" &&
      !!this.identity &&
      this.actionable(this.identity)
    );
  }

  private catchingUp(): LiveView {
    const identity = this.identity!;
    const agentControls = this.controlsView();
    return {
      ...this.cached,
      phase: this.sessionPhase(identity),
      id: this.viewId,
      persistenceScope: persistenceScope(identity.workspace, identity.threadId),
      agentControls,
      agentNotice: agentControls.available
        ? "Agent transcript is catching up. Input remains available."
        : "Agent transcript and turn state are catching up.",
    };
  }

  private controlsView(): NonNullable<LiveView["agentControls"]> {
    const controls = this.controls.view();
    return controls.available
      ? controls
      : {
          ...controls,
          inputUnavailableReason:
            "Agent input is paused while the current turn state catches up. Your draft is still editable.",
        };
  }

  private bindControls(identity: Identity) {
    if (!this.viewId) this.viewId = randomUUID();
    this.controls.bind({ ...identity, viewId: this.viewId });
  }

  private sessionPhase(identity: Identity): LiveView["phase"] {
    const state = this.observer?.latest();
    if (!state || !this.current(identity) || state.availability === "unavailable")
      return "unavailable";
    return this.attached(identity) ? "live" : "detached";
  }

  private interruptedRead(identity: Identity, client: ControlSocket): LiveView | undefined {
    if (this.eventClient === client && this.observer) return;
    if (this.observedReplacement(identity)) {
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    return this.retained("unavailable", "Agent transcript disconnected. Reconnecting…");
  }

  private retained(phase: LiveView["phase"], notice?: string): LiveView {
    if (!this.identity || !this.viewId) return empty(phase);
    const controls = this.controls.view();
    return {
      ...this.cached,
      phase,
      id: this.viewId,
      persistenceScope: persistenceScope(this.identity.workspace, this.identity.threadId),
      agentControls: {
        ...controls,
        available: false,
        inputUnavailableReason:
          phase === "offline"
            ? "Agent input is unavailable because the AgentVoice server is offline. Your draft is still editable."
            : phase === "connecting"
              ? "Agent input is unavailable while the AgentVoice session changes. Your draft is still editable."
              : "Agent input is unavailable while the transcript reader reconnects. Your draft is still editable.",
      },
      ...(notice ? { agentNotice: notice } : {}),
    };
  }

  private replacementFailure(error: unknown) {
    return (
      error instanceof SocketFailure &&
      ["instance_mismatch", "stale_generation"].includes(error.code ?? "")
    );
  }

  private diagnose(stage: ReaderStage, error: unknown) {
    const reason = diagnosticError(error);
    const key = `${stage}:${reason}`;
    const now = Date.now();
    if (now - (this.diagnosticAt.get(key) ?? 0) < DIAGNOSTIC_RATE_MS) return;
    this.diagnosticAt.set(key, now);
    if (this.diagnosticAt.size > 64)
      this.diagnosticAt.delete(this.diagnosticAt.keys().next().value!);
    const line = `${JSON.stringify({ observedAt: new Date(now).toISOString(), stage, error: reason })}\n`;
    try {
      const directory = join(this.stateDir, "web");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = lstatSync(directory);
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        directoryInfo.uid !== process.getuid?.()
      )
        return;
      chmodSync(directory, 0o700);
      const path = join(directory, "reader-diagnostics.jsonl");
      const previous = join(directory, "reader-diagnostics.previous.jsonl");
      const previousInfo = lstatSync(previous, { throwIfNoEntry: false });
      if (
        previousInfo &&
        (!previousInfo.isFile() ||
          previousInfo.isSymbolicLink() ||
          previousInfo.uid !== process.getuid?.() ||
          previousInfo.nlink !== 1)
      )
        return;
      if (previousInfo && previousInfo.size > DIAGNOSTIC_BYTES) rmSync(previous);
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (
        info &&
        (!info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.nlink !== 1)
      )
        return;
      if (info && info.size + Buffer.byteLength(line) > DIAGNOSTIC_BYTES) {
        if (lstatSync(previous, { throwIfNoEntry: false })) rmSync(previous);
        renameSync(path, previous);
      }
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1) return;
        fchmodSync(fd, 0o600);
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* Diagnostics must never make transcript recovery fail. */
    }
  }

  private sameIdentity(left: Identity, right: Identity) {
    return (
      left.workspace === right.workspace &&
      left.threadId === right.threadId &&
      left.instanceId === right.instanceId &&
      left.generation === right.generation &&
      left.controlProtocolVersion === right.controlProtocolVersion
    );
  }

  private async discoverIdentity(workspace: string, threadId: string): Promise<Identity> {
    this.stage = "controller.discover";
    const selected = await discoverControllerStatus(this.stateDir, workspace, threadId).catch(
      (error: unknown) => {
        // Older loaded controllers retain compatible status/event/attachment contracts.
        if (!(error instanceof Error) || !error.message.startsWith("no live AgentVoice controller"))
          throw error;
        return discoverControllerStatus(this.stateDir, workspace, threadId, 8).catch(
          (legacyError: unknown) => {
            if (
              !(legacyError instanceof Error) ||
              !legacyError.message.startsWith("no live AgentVoice controller")
            )
              throw legacyError;
            return discoverControllerStatus(this.stateDir, workspace, threadId, 7).catch(
              (olderError: unknown) => {
                if (
                  !(olderError instanceof Error) ||
                  !olderError.message.startsWith("no live AgentVoice controller")
                )
                  throw olderError;
                return discoverControllerStatus(this.stateDir, workspace, threadId, 6).catch(
                  (oldestError: unknown) => {
                    if (
                      !(oldestError instanceof Error) ||
                      !oldestError.message.startsWith("no live AgentVoice controller")
                    )
                      throw oldestError;
                    return discoverControllerStatus(this.stateDir, workspace, threadId, 5);
                  },
                );
              },
            );
          },
        );
      },
    );
    const controlProtocolVersion = selected.status.protocolVersion;
    if (
      controlProtocolVersion !== 5 &&
      controlProtocolVersion !== 6 &&
      controlProtocolVersion !== 7 &&
      controlProtocolVersion !== 8 &&
      controlProtocolVersion !== CONTROL_PROTOCOL_VERSION
    )
      throw new Error("Unsupported controller protocol");
    return {
      workspace,
      threadId,
      instanceId: selected.status.instanceId,
      generation: selected.status.generation,
      controlProtocolVersion,
    };
  }

  private async connectEvents(identity: Identity) {
    this.stage = "events.connect";
    let client!: ControlSocket;
    client = await ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
      (frame) => this.event(identity, client, frame),
    );
    if (!this.current(identity)) {
      client.close();
      throw new SocketFailure(
        this.observedReplacement(identity)
          ? "Call changed while reconnecting"
          : "Observer unavailable while reconnecting",
        this.observedReplacement(identity) ? "stale_generation" : "unavailable",
      );
    }
    this.eventClient = client;
    void client.done.then(() => {
      if (this.eventClient !== client) return;
      this.eventClient = undefined;
      this.verifiedClient = undefined;
      this.controls.disconnect();
      this.diagnose("events.closed", client.error() ?? new Error("Event socket disconnected"));
      this.cached = this.retained("unavailable", "Agent transcript disconnected. Reconnecting…");
      this.readAt = 0;
    });
    try {
      this.stage = "events.subscribe";
      await client.request("event.subscribe", { events: ["conversation.*"] });
    } catch (error) {
      if (this.eventClient === client) this.eventClient = undefined;
      client.close();
      throw error;
    }
  }

  private event(identity: Identity, client: ControlSocket, frame: Record<string, unknown>) {
    const data = frame["data"] as Record<string, unknown> | undefined;
    if (
      this.eventClient !== client ||
      !this.current(identity) ||
      data?.["instanceId"] !== identity.instanceId ||
      data?.["generation"] !== identity.generation
    )
      return;
    if (data?.["threadId"] != null && data["threadId"] !== identity.threadId) return;
    if (
      frame["event"] === "conversation.turn.started" ||
      frame["event"] === "conversation.turn.completed"
    ) {
      const turn = conversationTurnSchema.safeParse(data?.["turn"]);
      if (turn.success && typeof data?.["sequence"] === "number") {
        this.controls.observe(turn.data, this.actionable(identity), data["sequence"]);
        // Queued input belongs to the host and still runs when the page stops polling.
        if (frame["event"] === "conversation.turn.completed" && this.actionable(identity))
          void this.controls.drain();
      }
    }
    if (
      [
        "conversation.item.completed",
        "conversation.turn.completed",
        "conversation.gap",
        "conversation.thread.reverted",
      ].includes(String(frame["event"]))
    ) {
      this.historyRevision++;
      if (frame["event"] === "conversation.thread.reverted") {
        this.history = [];
        this.lifecycle.clear();
        this.agentOrder = [];
        this.pass = undefined;
      }
    }
  }

  private async update(): Promise<LiveView> {
    if (!this.observer) {
      try {
        this.stage = "observer.connect";
        const observer = await observeAttachmentServer(this.stateDir, this.workspace, false);
        if (this.closed) {
          observer.socket.close();
          return empty("offline");
        }
        this.observer = observer;
        void observer.socket.done.then(() => {
          if (this.observer === observer) {
            this.observer = undefined;
            const error = observer.socket.error() ?? new Error("Observer socket disconnected");
            this.diagnose("observer.closed", error);
            this.disconnectLive();
            this.cached = this.retained(
              "unavailable",
              "AgentVoice observer disconnected. Reconnecting…",
            );
          }
        });
      } catch (error) {
        const code = systemErrorCode(error);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          this.diagnose("observer.connect", error);
          this.scheduleRetry();
          return this.retained("offline", "AgentVoice server is offline. Reconnecting…");
        }
        throw error;
      }
    }
    const state = this.observer.latest();
    if (this.workspace && state.workspace && state.workspace !== this.workspace)
      throw new Error("Selected server reported a different workspace");
    if (!state.workspace || !state.threadId) {
      if (this.identity && state.availability !== "idle") {
        return this.retained(
          state.availability === "unavailable" ? "unavailable" : "connecting",
          state.availability === "unavailable"
            ? "AgentVoice server is unavailable. Reconnecting…"
            : "AgentVoice session identity is changing…",
        );
      }
      this.resetCall();
      return empty(
        state.availability === "unavailable" ? "unavailable" : state.busy ? "connecting" : "empty",
      );
    }
    if (this.identity && !this.current(this.identity)) {
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
    }
    if (!this.eventClient) {
      const discovered = await this.discoverIdentity(state.workspace, state.threadId);
      if (this.closed) return empty("offline");
      if (this.identity && !this.sameIdentity(this.identity, discovered)) {
        this.diagnose(
          "controller.identity",
          new SocketFailure("Controller identity changed", "stale_generation"),
        );
        this.resetCall();
      }
      const identity = this.identity ?? discovered;
      if (!this.identity) this.identity = identity;
      this.bindControls(identity);
      await this.connectEvents(identity);
    } else this.bindControls(this.identity!);
    const identity = this.identity!;
    const client = this.eventClient!;
    this.stage = "events.snapshot";
    const before = eventSnapshotSchema.parse(await client.request("state.get", {}));
    const interruptedSnapshot = this.interruptedRead(identity, client);
    if (interruptedSnapshot) return interruptedSnapshot;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    if (
      before.instanceId !== identity.instanceId ||
      before.generation !== identity.generation ||
      before.runtime.workspace !== identity.workspace ||
      before.runtime.mainThreadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.diagnose(
        "events.snapshot",
        new SocketFailure("Event snapshot identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    const root = before.threads.find((thread) => thread.id === identity.threadId);
    const params = {
      expectedInstanceId: identity.instanceId,
      expectedGeneration: identity.generation,
      rootThreadId: identity.threadId,
      threadId: identity.threadId,
    };
    this.stage = "conversation.live";
    const live = liveSchema.parse(await client.request("conversation.live.get", params));
    const interruptedLive = this.interruptedRead(identity, client);
    if (interruptedLive) return interruptedLive;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    if (
      live.instanceId !== identity.instanceId ||
      live.generation !== identity.generation ||
      live.threadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.diagnose(
        "conversation.live",
        new SocketFailure("Live conversation identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    this.verifiedClient = client;
    const turn = controlTurn(root, live.turns);
    this.controls.observe(
      turn,
      this.actionable(identity) && inputAvailable(root, turn),
      before.sequence,
    );
    if (root?.status === "active" && !root.turn) {
      try {
        this.stage = "conversation.turns";
        const turns = turnsSchema.parse(
          await this.readTurns(identity, {
            ...params,
            limit: 1,
            sortDirection: "desc",
          }),
        );
        if (
          turns.instanceId !== identity.instanceId ||
          turns.generation !== identity.generation ||
          turns.threadId !== identity.threadId ||
          turns.rootThreadId !== identity.threadId
        )
          throw new SocketFailure("Turn read identity changed", "stale_generation");
        if (this.current(identity))
          this.controls.observe(turns.data[0], this.actionable(identity), live.throughSequence);
        else if (this.observedReplacement(identity))
          throw new SocketFailure("Turn read identity changed", "stale_generation");
      } catch (error) {
        this.diagnose("conversation.turns", error);
        if (this.replacementFailure(error)) throw error;
        /* Transcript reads remain available while the active turn cannot be confirmed. */
      }
    }
    // Establish the current live incarnation before consuming a background history slot.
    // This keeps a newly opened reader useful while the root is actively working.
    this.loadHistoryPage(identity, params);
    const entries = new Map(this.history.map((entry) => [itemKey(entry), entry]));
    const messages = new Map(this.history.map((entry) => [itemKey(entry), agentMessage(entry)]));
    for (const entry of live.items) {
      if (
        entry.item.type === "subAgentActivity" &&
        ["started", "completed", "interrupted"].includes(entry.item.kind)
      )
        this.lifecycle.set(itemKey(entry), entry);
      // Incomplete live text cannot replace canonical history or establish delta overlap.
      if (entry.complete || !messages.has(itemKey(entry))) {
        entries.set(itemKey(entry), entry);
        messages.set(itemKey(entry), agentMessage(entry, entry.completed));
      }
    }
    const authoritativeOrder = [...messages.keys()];
    for (const [key, entry] of this.lifecycle)
      if (!messages.has(key)) messages.set(key, agentMessage(entry));
    // Native history groups a lifecycle observation with the parent turn that
    // initiated the child. A completion can arrive much later, after newer
    // turns, so a history refresh (notably after compaction) may move a card
    // backwards even though the reader already showed it at the live edge.
    // Once observed, reader order owns that lifecycle row until an explicit
    // revert/incarnation reset. Remove retained rows from the refreshed order
    // and place them back relative to the rows that surrounded them live.
    const authoritative = new Set(authoritativeOrder);
    const hasSurvivingAnchor = this.agentOrder.some(
      (key) => authoritative.has(key) && !this.lifecycle.has(key),
    );
    const retained = new Set(
      hasSurvivingAnchor ? this.agentOrder.filter((key) => this.lifecycle.has(key)) : [],
    );
    const order = authoritativeOrder.filter((key) => !retained.has(key));
    const included = new Set(order);
    for (let index = 0; index < this.agentOrder.length; index++) {
      const key = this.agentOrder[index]!;
      if (included.has(key) || !this.lifecycle.has(key)) continue;
      const next = this.agentOrder.slice(index + 1).find((candidate) => included.has(candidate));
      if (next) order.splice(order.indexOf(next), 0, key);
      else {
        const previous = this.agentOrder
          .slice(0, index)
          .reverse()
          .find((candidate) => included.has(candidate));
        if (previous) order.splice(order.indexOf(previous) + 1, 0, key);
        else order.push(key);
      }
      included.add(key);
    }
    this.agentOrder = order;
    let voiceNotice = this.voice.notice;
    try {
      if (!this.tail) {
        const recording = savedRecordings(this.stateDir, identity.workspace).find(
          (row) => row.threadId === identity.threadId,
        );
        if (recording) this.tail = new VoiceRecordingTail(recording.path, identity);
      }
      if (this.tail) {
        // Drain available chunks, including a long record split across reads, with a per-poll budget.
        for (let count = 0; count < 32; count++) {
          const lines = this.tail.read();
          for (const line of lines) this.voice.accept(line, identity.threadId);
          if (lines.length === 0 && this.tail.initialHistoryLoaded) break;
        }
      } else voiceNotice = "Waiting for the voice transcript.";
    } catch (error) {
      this.diagnose("voice.tail", error);
      voiceNotice = "Voice transcript unavailable. Reconnecting…";
      this.tail?.close();
      this.tail = undefined;
    }
    const interruptedFinal = this.interruptedRead(identity, client);
    if (interruptedFinal) return interruptedFinal;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.resetCall();
      return empty("connecting");
    }
    if (this.actionable(identity)) void this.controls.drain();
    const rendered = new Set(order);
    const delegated = new Map<
      string,
      { input: string; bodyLength: number; key: string; order: number }[]
    >();
    // While native persistence catches up, a history read can expose its
    // response-item view alongside the same item received from the live event
    // feed. Only collapse those alternate projections after the complete saved
    // voice tail proves how many matching human segments were actually observed.
    // This retains separately repeated speech, and leaves uncorrelated native
    // messages visible if the recording is unavailable or incomplete.
    const completeVoiceHistory = this.tail?.initialHistoryLoaded === true;
    if (completeVoiceHistory) {
      for (const [position, key] of order.entries()) {
        const entry = entries.get(key);
        const input = entry && voiceDelegationInput(entry);
        if (!input) continue;
        const message = messages.get(key);
        const group = delegated.get(entry.turnId) ?? [];
        group.push({
          input,
          bodyLength: message?.presentation?.body.length ?? input.length,
          key,
          order: position,
        });
        delegated.set(entry.turnId, group);
      }
      for (const turn of delegated.values()) {
        const pending = new Set(turn);
        while (pending.size > 0) {
          const first = pending.values().next().value!;
          pending.delete(first);
          const group = [first];
          for (let changed = true; changed; ) {
            changed = false;
            for (const candidate of pending) {
              if (
                !group.some(
                  (member) =>
                    member.input.startsWith(candidate.input) ||
                    candidate.input.startsWith(member.input),
                )
              )
                continue;
              pending.delete(candidate);
              group.push(candidate);
              changed = true;
            }
          }
          const longest = group.reduce((left, right) =>
            right.input.length > left.input.length ? right : left,
          ).input;
          const exactInputs = new Set(group.map((candidate) => candidate.input));
          let observed = this.voice.userTranscriptCount(longest);
          // Realtime can publish cumulative snapshots while one long human
          // segment remains open. Require a substantial, evolving prefix chain
          // and one completed canonical segment before collapsing that chain.
          if (observed === 0 && longest.length >= 64 && exactInputs.size > 1)
            observed = this.voice.completedUserTranscriptContainingCount(longest);
          if (observed === 0 || group.length <= observed) continue;
          // Prefer the fullest reconstructed card. Break ties toward the latest
          // identity so a live item wins over an earlier history projection.
          const keep = new Set(
            group
              .toSorted(
                (left, right) => right.bodyLength - left.bodyLength || right.order - left.order,
              )
              .slice(0, observed)
              .map((candidate) => candidate.key),
          );
          for (const candidate of group)
            if (!keep.has(candidate.key)) rendered.delete(candidate.key);
        }
      }
    }
    return {
      phase: this.sessionPhase(identity),
      id: this.viewId,
      persistenceScope: persistenceScope(identity.workspace, identity.threadId),
      voice: this.voice.messages(),
      agent: order.flatMap((key) => {
        const message = messages.get(key);
        return message && rendered.has(key) ? [message] : [];
      }),
      agentHistoryLoading: !this.initialHistorySettled,
      voiceHistoryLoading: this.tail ? !this.tail.initialHistoryLoaded : false,
      agentControls: this.controlsView(),
      voiceNotice: voiceNotice ?? this.voice.notice,
      agentNotice:
        this.historyNotice ??
        (live.items.some((entry) => !entry.complete)
          ? "Some live text is incomplete; waiting for the completed item."
          : undefined),
    };
  }

  private loadHistoryPage(identity: Identity, params: Record<string, unknown>) {
    if (
      this.historyPending ||
      Date.now() < this.historyRetryAt ||
      (!this.historyRefreshNeeded &&
        this.loadedRevision === this.historyRevision &&
        this.historyRetryAt === 0)
    )
      return;
    if (!this.pass) {
      this.pass = { rows: [], bytes: 0, revision: this.historyRevision };
      if (!this.initialHistorySettled) {
        const initial = this.pass;
        this.historyTimer = setTimeout(() => {
          if (!this.current(identity) || this.pass !== initial) return;
          // Keep the pass private but let the reader leave its initial loading state.
          // The outstanding page or its retry still owns completion.
          this.publishHistory(
            initial,
            "Showing recent messages while earlier history loads.",
            false,
          );
        }, this.initialHistoryBudgetMs);
      }
    }
    const pass = this.pass;
    const attempt: HistoryAttempt = {};
    this.historyAttempt = attempt;
    this.historyPending = true;
    if (!this.initialHistorySettled) this.historyNotice = "Loading earlier messages…";
    void this.historyPage(identity, pass, attempt, params)
      .then(({ raw, client }) => {
        if (
          !this.current(identity) ||
          this.pass !== pass ||
          this.historyAttempt !== attempt ||
          attempt.client !== client ||
          this.historyClient !== client
        )
          return;
        const page = historySchema.parse(raw);
        if (
          page.instanceId !== identity.instanceId ||
          page.generation !== identity.generation ||
          page.threadId !== identity.threadId ||
          page.rootThreadId !== identity.threadId
        )
          throw new SocketFailure("History identity changed", "stale_generation");
        pass.rows.push(...page.data);
        pass.bytes += Buffer.byteLength(JSON.stringify(page.data));
        const bounded = pass.rows.length >= 10_000 || pass.bytes >= 8 * 1024 * 1024;
        this.historyNotice = bounded
          ? "Showing the latest available history (viewer limit reached)."
          : page.nextCursor
            ? "Loading earlier messages…"
            : undefined;
        if (!page.nextCursor || bounded) {
          // Keep incomplete passes private: prepending every page makes the following scroller walk.
          this.publishHistory(pass, this.historyNotice);
        } else pass.cursor = page.nextCursor;
      })
      .catch((error) => {
        if (
          !this.current(identity) ||
          this.pass !== pass ||
          this.historyAttempt !== attempt ||
          (attempt.client !== undefined && this.historyClient !== attempt.client)
        )
          return;
        this.diagnose("history.page", error);
        if (this.replacementFailure(error)) {
          this.resetCall();
          this.retryAt = 0;
          return;
        }
        this.historyRefreshNeeded = true;
        const notice = this.historyCapacityPressure(error)
          ? "Earlier Agent history is waiting for capacity while current Agent work runs."
          : "Earlier Agent history is unavailable. Retrying in the background.";
        if (!this.initialHistorySettled) this.publishHistory(pass, notice, false);
        else {
          this.pass = undefined;
          this.historyNotice = notice;
        }
        this.historyRetryAt = Date.now() + this.historyRetryMs;
        this.scheduleHistoryRetry(identity, params);
      })
      .finally(() => {
        if (
          this.historyAttempt !== attempt ||
          (attempt.client !== undefined && this.historyClient !== attempt.client)
        )
          return;
        if (attempt.closed && this.historyClient === attempt.client) this.historyClient = undefined;
        this.historyAttempt = undefined;
        this.historyPending = false;
        // Paging is a host task, not one page per browser poll.
        if (this.current(identity) && this.pass === pass) this.loadHistoryPage(identity, params);
      });
  }

  private async historyPage(
    identity: Identity,
    pass: HistoryPass,
    attempt: HistoryAttempt,
    params: Record<string, unknown>,
  ) {
    const client = await this.backgroundClient(identity);
    if (!this.current(identity) || this.pass !== pass || this.historyAttempt !== attempt)
      throw new Error("History attempt changed");
    attempt.client = client;
    const raw = await client.request("conversation.items.list", {
      ...params,
      sortDirection: "desc",
      limit: 50,
      ...(pass.cursor ? { cursor: pass.cursor } : {}),
    });
    return { raw, client };
  }

  private async readTurns(identity: Identity, params: Record<string, unknown>) {
    const client = await ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
    );
    try {
      if (!this.current(identity)) throw new Error("Turn read attempt changed");
      return await client.request("conversation.turns.list", params);
    } finally {
      client.close();
    }
  }

  private backgroundClient(identity: Identity): Promise<ControlSocket> {
    if (this.historyClient) return Promise.resolve(this.historyClient);
    if (this.historyConnectPending) return this.historyConnectPending;
    const pending = ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
    ).then((client) => {
      if (this.historyConnectPending !== pending || !this.current(identity)) {
        client.close();
        throw new Error("History attempt changed");
      }
      this.historyClient = client;
      void client.done.then(() => {
        if (this.historyClient !== client) return;
        const attempt = this.historyAttempt;
        if (attempt?.client === client) attempt.closed = true;
        else this.historyClient = undefined;
        this.diagnose("history.closed", client.error() ?? new Error("History socket disconnected"));
      });
      return client;
    });
    this.historyConnectPending = pending;
    void pending.then(
      () => {
        if (this.historyConnectPending === pending) this.historyConnectPending = undefined;
      },
      (error) => {
        if (this.historyConnectPending === pending) this.historyConnectPending = undefined;
        this.diagnose("history.connect", error);
      },
    );
    return pending;
  }

  private publishHistory(pass: HistoryPass, notice?: string, complete = true) {
    this.history = [...pass.rows].reverse();
    this.initialHistorySettled = true;
    this.historyNotice = notice;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    if (!complete) {
      this.readAt = 0;
      return;
    }
    this.loadedRevision = pass.revision;
    this.historyRefreshNeeded = false;
    this.historyRetryAt = 0;
    clearTimeout(this.historyRetryTimer);
    this.historyRetryTimer = undefined;
    this.pass = undefined;
    this.readAt = 0;
  }

  private historyCapacityPressure(error: unknown) {
    return error instanceof SocketFailure && error.code === "busy";
  }

  private scheduleHistoryRetry(identity: Identity, params: Record<string, unknown>) {
    clearTimeout(this.historyRetryTimer);
    const delay = Math.max(0, this.historyRetryAt - Date.now());
    this.historyRetryTimer = setTimeout(() => {
      this.historyRetryTimer = undefined;
      if (!this.current(identity)) return;
      this.historyRetryAt = 0;
      this.loadHistoryPage(identity, params);
    }, delay);
  }
}
