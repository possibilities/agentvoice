import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type LocalImageAttachment,
  MAX_LOCAL_IMAGES,
} from "../../src/attachment/image-contract.ts";
import { validateLocalImagePaths } from "../../src/attachment/local-images.ts";
import type { AgentControlsView } from "../src/types.ts";
import {
  type AgentOperation,
  AgentSendError,
  type AgentTarget,
  sendAgentOperation,
} from "./agent-sender.ts";

const text = z.string().refine((value) => Buffer.byteLength(value) <= 64 * 1024);
const images = z
  .array(z.object({ path: z.string().min(1).max(4096) }).strict())
  .max(MAX_LOCAL_IMAGES)
  .optional();
const base = { viewId: z.string().uuid(), requestId: z.string().uuid() };
export const agentCommandSchema = z
  .discriminatedUnion("action", [
    z.object({ ...base, action: z.literal("send"), text, images }).strict(),
    z.object({ ...base, action: z.literal("steer"), text, images }).strict(),
    z.object({ ...base, action: z.literal("queue"), text, images }).strict(),
    z.object({ ...base, action: z.literal("interrupt") }).strict(),
    z.object({ ...base, action: z.literal("edit"), id: z.string().uuid(), text, images }).strict(),
    z.object({ ...base, action: z.literal("remove"), id: z.string().uuid() }).strict(),
    z.object({ ...base, action: z.literal("resume"), id: z.string().uuid() }).strict(),
    z.object({ ...base, action: z.literal("steerQueued"), id: z.string().uuid() }).strict(),
    z.object({ ...base, action: z.literal("editing"), id: z.string().uuid().nullable() }).strict(),
  ])
  .superRefine((command, context) => {
    if (
      "text" in command &&
      command.text.trim().length === 0 &&
      (command.images?.length ?? 0) === 0
    )
      context.addIssue({
        code: "custom",
        message: "A message requires text or at least one image.",
      });
  });
export type AgentCommand = z.infer<typeof agentCommandSchema>;
type Target = AgentTarget & { viewId: string };
type Row = {
  id: string;
  text: string;
  images?: LocalImageAttachment[];
  target: Target;
  pausedReason?: string;
  unknown?: boolean;
  clientUserMessageId?: string;
};
type Turn = { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" };
type Send = (
  target: AgentTarget,
  operation: AgentOperation,
  current: () => boolean,
) => Promise<string | undefined>;
const savedRow = z
  .object({
    id: z.string().uuid(),
    text,
    images,
    target: z.object({
      viewId: z.string().uuid(),
      instanceId: z.string(),
      generation: z.number(),
      workspace: z.string(),
      threadId: z.string(),
      controlProtocolVersion: z.union([z.literal(5), z.literal(6)]),
    }),
    clientUserMessageId: z.string().uuid().optional(),
    pausedReason: z.string().optional(),
    unknown: z.boolean().optional(),
  })
  .refine((row) => row.text.trim().length > 0 || (row.images?.length ?? 0) > 0);

/** A host-owned FIFO. Native history contains only input that Codex actually accepts. */
export class AgentControls {
  private target?: Target;
  private turn?: Turn;
  private available = false;
  private sequence = -1;
  private pending = false;
  private stopping?: string;
  private editing?: string;
  private queue: Row[] = [];
  private persisted: Row[] = [];
  private notice?: string;
  private readonly path: string;
  private readonly requests = new Map<string, { body: string; result: Promise<void> }>();
  private readonly send: Send;

  constructor(stateDir: string, send?: Send, workspace?: string) {
    // Reader selection is host-owned. Keep the existing default endpoint's recovery
    // file, but never expose it to an explicitly selected workspace server.
    this.path =
      workspace === undefined
        ? join(stateDir, "web", "queued-messages.json")
        : join(
            stateDir,
            "web",
            "queues",
            createHash("sha256").update(workspace).digest("hex"),
            "queued-messages.json",
          );
    this.send =
      send ??
      ((target, operation, current) => sendAgentOperation(stateDir, target, operation, current));
    try {
      const info = lstatSync(this.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        // JSON escaping can expand the bounded 20 × 64 KiB text queue sixfold.
        info.size > 8 * 1024 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()
      )
        throw new Error();
      this.queue = z
        .array(savedRow)
        .max(20)
        .parse(JSON.parse(readFileSync(this.path, "utf8")))
        .map((row) => ({
          ...row,
          pausedReason: row.unknown
            ? "Delivery is unknown. Check the transcript before editing or removing this message."
            : "Restored after the web server restarted. Review before resuming.",
        }));
      this.persisted = structuredClone(this.queue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.notice = "Saved queued messages could not be read. The saved file was preserved.";
    }
  }

  bind(target: Target) {
    if (this.target?.viewId === target.viewId) return;
    this.disconnect();
    this.target = target;
    this.sequence = -1;
  }

  disconnect() {
    this.available = false;
    this.target = undefined;
    this.turn = undefined;
    this.stopping = undefined;
    this.editing = undefined;
    this.pause("The call changed. Review queued messages before resuming.");
  }

  observe(turn: Turn | undefined, available: boolean, sequence: number) {
    if (!this.target || sequence < this.sequence) return;
    this.sequence = sequence;
    this.available = available;
    const interrupted =
      turn?.status === "interrupted" &&
      (this.turn?.id !== turn.id || this.turn?.status !== turn.status);
    this.turn = turn;
    if (interrupted) this.pause("Stopped. Resume this message when ready.");
    if (this.stopping && (turn?.id !== this.stopping || turn.status !== "inProgress"))
      this.stopping = undefined;
  }

  view(): AgentControlsView {
    return {
      available: this.available,
      active: this.turn?.status === "inProgress",
      stopping: !!this.stopping,
      pending: this.pending,
      notice: this.notice,
      queue: this.queue.map((row) => ({
        id: row.id,
        text: row.text,
        ...(row.images ? { images: structuredClone(row.images) } : {}),
        pausedReason:
          this.editing === row.id
            ? "Being edited. Resume to release this message."
            : row.pausedReason,
        canSteer:
          !row.unknown &&
          !this.stopping &&
          this.available &&
          row.target.viewId === this.target?.viewId,
        canResume:
          !row.unknown && this.available && (!!row.pausedReason || this.editing === row.id),
        disabled: this.pending,
      })),
    };
  }

  command(command: AgentCommand): Promise<void> {
    const body = JSON.stringify(command);
    const prior = this.requests.get(command.requestId);
    if (prior)
      return prior.body === body
        ? prior.result
        : Promise.reject(new Error("Request identity reused."));
    const result = this.apply(command);
    this.requests.set(command.requestId, { body, result });
    if (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value!);
    return result;
  }

  private async apply(command: AgentCommand) {
    if (!this.target || command.viewId !== this.target.viewId)
      throw new Error("The call changed. Review the current Agent before submitting.");
    if (this.pending) throw new Error("An Agent request is still pending.");
    if (command.action === "editing") {
      if (command.id && !this.queue.some((row) => row.id === command.id))
        throw new Error("That queued message is no longer available.");
      this.editing = command.id ?? undefined;
      return;
    }
    if (command.action === "queue") {
      if (!this.available) throw new Error("Agent is unavailable. The draft was not queued.");
      if (this.notice) throw new Error(this.notice);
      if (this.queue.length >= 20) throw new Error("The queue is full (20 messages).");
      this.validateImages(command.images, this.target);
      this.queue.push({
        id: command.requestId,
        text: command.text,
        ...(command.images ? { images: structuredClone(command.images) } : {}),
        target: { ...this.target },
        pausedReason: this.stopping ? "Stopped. Resume this message when ready." : undefined,
      });
      this.save();
      return;
    }
    if ("id" in command) {
      const row = this.queue.find((row) => row.id === command.id);
      if (!row) throw new Error("That queued message is no longer available.");
      if (command.action === "remove") this.queue = this.queue.filter((entry) => entry !== row);
      else if (command.action === "edit") {
        this.validateImages(command.images, this.target);
        Object.assign(row, {
          text: command.text,
          images: command.images ? structuredClone(command.images) : undefined,
          clientUserMessageId: command.requestId,
          target: { ...this.target },
          pausedReason: undefined,
          unknown: false,
        });
      } else if (command.action === "resume") {
        if (row.unknown) throw new Error("Delivery is unknown. Check the transcript first.");
        this.validateImages(row.images, this.target);
        Object.assign(row, { target: { ...this.target }, pausedReason: undefined });
        if (this.editing === row.id) this.editing = undefined;
      } else if (command.action === "steerQueued") {
        if (row.unknown || row.target.viewId !== this.target.viewId)
          throw new Error("Review this message before submitting it to the current call.");
        await this.submitRow(row);
      }
      this.save();
      return;
    }
    if (!this.available || this.stopping)
      throw new Error("Agent is unavailable or stopping. The draft was not sent.");
    if (command.action === "interrupt") {
      if (this.turn?.status !== "inProgress") throw new Error("No active turn to stop.");
      this.pause("Stopped. Resume this message when ready.");
      this.stopping = this.turn.id;
      try {
        await this.dispatch({ action: "interrupt", turnId: this.turn.id });
      } catch (error) {
        this.stopping = undefined;
        throw error;
      }
    } else if (command.action === "steer") {
      if (this.turn?.status !== "inProgress")
        throw new Error("The turn finished. Use Send to start the next turn.");
      await this.dispatch({
        action: "steer",
        text: command.text,
        ...(command.images ? { images: command.images } : {}),
        turnId: this.turn.id,
        clientUserMessageId: command.requestId,
      });
    } else {
      if (this.turn?.status === "inProgress")
        throw new Error("Agent is working. Choose Steer or Queue.");
      await this.dispatch({
        action: "send",
        text: command.text,
        ...(command.images ? { images: command.images } : {}),
        clientUserMessageId: command.requestId,
      });
    }
  }

  async drain() {
    const row = this.queue[0];
    if (
      this.notice ||
      !row ||
      row.pausedReason ||
      row.unknown ||
      this.editing === row.id ||
      this.pending ||
      this.stopping ||
      !this.available ||
      this.turn?.status === "inProgress" ||
      row.target.viewId !== this.target?.viewId
    )
      return;
    try {
      await this.submitRow(row);
    } catch {
      /* The row carries the failure; never retry it automatically. */
    }
  }

  private async submitRow(row: Row) {
    row.unknown = true;
    row.pausedReason = "Sending…";
    this.save();
    try {
      await this.dispatch(
        this.turn?.status === "inProgress"
          ? {
              action: "steer",
              turnId: this.turn.id,
              text: row.text,
              ...(row.images ? { images: row.images } : {}),
              clientUserMessageId: row.clientUserMessageId ?? row.id,
            }
          : {
              action: "send",
              text: row.text,
              ...(row.images ? { images: row.images } : {}),
              clientUserMessageId: row.clientUserMessageId ?? row.id,
            },
      );
      this.queue = this.queue.filter((entry) => entry !== row);
    } catch (error) {
      row.unknown = error instanceof AgentSendError && error.delivery === "unknown";
      row.pausedReason = error instanceof Error ? error.message : "Message was not sent.";
      throw error;
    } finally {
      this.save();
    }
  }

  private async dispatch(operation: AgentOperation) {
    const target = this.target;
    if (!target || !this.available || (this.stopping && operation.action !== "interrupt"))
      throw new Error("Agent is unavailable or stopping. Nothing was sent.");
    if (operation.action !== "interrupt") this.validateImages(operation.images, target);
    const turnId = this.turn?.status === "inProgress" ? this.turn.id : undefined;
    this.pending = true;
    try {
      const sequence = this.sequence;
      const acceptedTurnId = await this.send(
        target,
        operation,
        () =>
          this.target === target &&
          this.available &&
          (operation.action === "send"
            ? this.turn?.status !== "inProgress"
            : this.turn?.id === turnId && this.turn?.status === "inProgress"),
      );
      if (this.target === target && this.sequence === sequence && acceptedTurnId) {
        this.turn = { id: acceptedTurnId, status: "inProgress" };
        // Only a new turn needs a fence against the idle snapshot from before acceptance.
        if (operation.action === "send") this.sequence++;
      }
    } finally {
      this.pending = false;
    }
  }

  private validateImages(images: readonly LocalImageAttachment[] | undefined, target: AgentTarget) {
    if (!images?.length) return;
    try {
      validateLocalImagePaths(images, target);
    } catch {
      throw new Error("An attached image is unavailable. Add it again.");
    }
  }

  private pause(reason: string) {
    let changed = false;
    for (const row of this.queue)
      if (!row.pausedReason) {
        row.pausedReason = reason;
        changed = true;
      }
    if (changed) {
      try {
        this.save();
      } catch {
        /* Preserve the on-disk queue and show the storage failure. */
      }
    }
  }

  private save() {
    if (this.notice) throw new Error(this.notice);
    const directory = join(this.path, "..");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        throw new Error();
      chmodSync(directory, 0o700);
      writeFileSync(temporary, JSON.stringify(this.queue), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      this.persisted = structuredClone(this.queue);
    } catch {
      rmSync(temporary, { force: true });
      this.queue = structuredClone(this.persisted);
      this.notice = "Queued messages could not be saved. The queue is paused.";
      throw new Error(this.notice);
    }
  }
}
