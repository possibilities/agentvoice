import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { discoverControllerStatus } from "../control/discovery.ts";
import type { ControlStatus } from "../control/types.ts";
import { observeFrontend } from "../frontend/observer.ts";
import { type FrontendObservation, frontendSocketPath } from "../frontend/protocol.ts";
import { safeAncestors } from "../private-files.ts";
import { savedRecordings } from "../recording/store.ts";

export const MAX_ATTACHMENT_FRAME = 2 * 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const attachmentIdentitySchema = z
  .object({
    clientId: z.string().uuid(),
    workspace: z.string().min(1).max(4096).refine(isAbsolute),
    threadId: z.string().min(1).max(256),
    instanceId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
  })
  .strict();
export type AttachmentIdentity = z.infer<typeof attachmentIdentitySchema>;
export function sameAttachment(a: AttachmentIdentity, b: AttachmentIdentity) {
  return (
    a.clientId === b.clientId &&
    a.workspace === b.workspace &&
    a.threadId === b.threadId &&
    a.instanceId === b.instanceId &&
    a.generation === b.generation
  );
}
export const attachmentFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(1),
      type: z.literal("waiting"),
      message: z.enum([
        "Waiting for a call",
        "Starting backend",
        "Waiting for the selected workspace",
      ]),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("session"),
      identity: attachmentIdentitySchema,
      agentReady: z.boolean(),
      phase: z.string().max(64),
    })
    .strict(),
  z
    .object({ v: z.literal(1), type: z.literal("voice"), line: z.string().max(1024 * 1024) })
    .strict(),
]);
export type AttachmentFrame = z.infer<typeof attachmentFrameSchema>;

/** One opened inode, complete bounded records only; never follow replacement files. */
export class VoiceRecordingTail {
  private readonly fd: number;
  private readonly inode: number;
  private readonly device: number;
  private offset = 0;
  private pending = Buffer.alloc(0);
  private header = false;
  constructor(
    private readonly path: string,
    private readonly selected: { workspace: string; threadId: string },
  ) {
    safeAncestors(dirname(path));
    this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(this.fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.mode & 0o077
    ) {
      closeSync(this.fd);
      throw new Error("Unsafe voice transcript");
    }
    this.inode = info.ino;
    this.device = info.dev;
  }
  read(): string[] {
    const info = lstatSync(this.path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.ino !== this.inode ||
      info.dev !== this.device ||
      info.size < this.offset
    )
      throw new Error("Voice transcript was replaced or truncated");
    if (info.size > MAX_TRANSCRIPT_BYTES)
      throw new Error("Voice transcript exceeds the viewer limit");
    const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset));
    const count = readSync(this.fd, chunk, 0, chunk.length, this.offset);
    this.offset += count;
    this.pending = Buffer.concat([this.pending, chunk.subarray(0, count)]);
    const lines: string[] = [];
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) break;
      if (newline > 1024 * 1024) throw new Error("Voice record exceeds the viewer limit");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(
        this.pending.subarray(0, newline),
      );
      const record = JSON.parse(line) as Record<string, unknown>;
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("Invalid voice record");
      if (!this.header) {
        if (
          record["type"] !== "voice_transcript" ||
          record["format"] !== "agentvoice" ||
          record["workspace"] !== this.selected.workspace ||
          record["threadId"] !== this.selected.threadId
        )
          throw new Error("Voice transcript identity changed");
        this.header = true;
      }
      lines.push(line);
      this.pending = this.pending.subarray(newline + 1);
    }
    if (this.pending.length > 1024 * 1024) throw new Error("Voice record exceeds the viewer limit");
    return lines;
  }
  close() {
    closeSync(this.fd);
  }
}

export async function observeAttachmentServer(stateDir: string, workspace?: string) {
  let path = frontendSocketPath(stateDir, workspace);
  if (workspace && !lstatSync(path, { throwIfNoEntry: false })) path = frontendSocketPath(stateDir);
  let latest: FrontendObservation | undefined;
  const observation = await observeFrontend(path, (value) => {
    latest = value;
  });
  latest ??= observation.initial;
  return { ...observation, latest: () => latest! };
}

/** This stdout bridge exports observation and voice text, never controller tickets or sockets. */
export async function streamAttachmentSession(
  stateDir: string,
  workspace: string | undefined,
  write: (frame: AttachmentFrame) => Promise<void>,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  const observation = await observeAttachmentServer(stateDir, workspace);
  let owner: string | undefined;
  let selected: AttachmentIdentity | undefined;
  let tail: VoiceRecordingTail | undefined;
  let ended = false;
  void observation.socket.done.then(() => {
    ended = true;
  });
  try {
    while (!signal.aborted && !ended) {
      const state = observation.latest();
      if (owner && (state.clientId !== owner || state.availability !== "connected")) return;
      if (state.availability === "unavailable") throw new Error("AgentVoice server is unavailable");
      if (workspace && state.workspace && state.workspace !== workspace) {
        await write({ v: 1, type: "waiting", message: "Waiting for the selected workspace" });
      } else if (state.availability !== "connected" || !state.clientId) {
        await write({ v: 1, type: "waiting", message: "Waiting for a call" });
      } else {
        // With an explicit selection, an as-yet unknown workspace does not select a call.
        if (!workspace || state.workspace === workspace) owner = state.clientId;
        if (!state.workspace || !state.threadId) {
          await write({ v: 1, type: "waiting", message: "Starting backend" });
        } else {
          let status: ControlStatus | undefined;
          try {
            status = (await discoverControllerStatus(stateDir, state.workspace, state.threadId))
              .status;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.startsWith("no live AgentVoice controller")
            )
              throw error;
          }
          if (status) {
            const current = attachmentIdentitySchema.parse({
              clientId: owner,
              workspace: state.workspace,
              threadId: state.threadId,
              instanceId: status.instanceId,
              generation: status.generation,
            });
            if (selected && !sameAttachment(current, selected))
              throw new Error("Backend changed. Run agentvoice --attach again.");
            selected = current;
            const latest = observation.latest();
            if (
              latest.clientId !== owner ||
              latest.availability !== "connected" ||
              latest.workspace !== current.workspace ||
              latest.threadId !== current.threadId
            )
              return;
            await write({
              v: 1,
              type: "session",
              identity: current,
              phase: status.runtime.phase,
              agentReady: status.runtime.attachmentReady ?? status.runtime.phase === "ready",
            });
            if (!tail) {
              const recording = savedRecordings(stateDir, current.workspace).find(
                (item) => item.threadId === current.threadId,
              );
              if (recording) tail = new VoiceRecordingTail(recording.path, current);
            }
            if (tail) for (const line of tail.read()) await write({ v: 1, type: "voice", line });
          } else {
            if (selected) throw new Error("Backend is no longer available");
            await write({ v: 1, type: "waiting", message: "Starting backend" });
          }
        }
      }
      await Promise.race([Bun.sleep(250), observation.socket.done]);
    }
    if (!signal.aborted && ended)
      throw observation.socket.error() ?? new Error("AgentVoice server disconnected");
  } finally {
    tail?.close();
    observation.socket.close();
  }
}
