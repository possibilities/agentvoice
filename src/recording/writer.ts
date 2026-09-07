import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lockThread } from "../core/thread-lock.ts";
import { EVENT_PROTOCOL_VERSION } from "../events/contract.ts";
import { voiceNotificationSchema } from "../events/voice.ts";
import { ownedDirectory } from "../private-files.ts";

const context = {
  instanceId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
};
export const recordedVoiceFrame = z.union(
  voiceNotificationSchema.options.map((schema) =>
    z
      .object({
        v: z.literal(EVENT_PROTOCOL_VERSION),
        type: z.literal("event"),
        event: schema.shape.event,
        data: schema.shape.data.extend(context).strict(),
      })
      .strict(),
  ),
);
const MAX_RECORD_BYTES = 1 << 20;

/** Append-only observation, independent of native history and runtime audio. */
export class VoiceRecording {
  private readonly files = new Map<string, number>();
  private readonly recordingId = randomUUID();
  private readonly releases = new Map<string, () => void>();
  private readonly directory: string;
  private identity: string | undefined;
  private closed = false;
  private readonly damaged = new Set<number>();

  constructor(
    private readonly workspace: string,
    directory: string,
    private readonly opened: (path: string) => void = () => {},
  ) {
    ownedDirectory(directory);
    this.directory = directory;
  }

  private write(fd: number, value: object, durable = false): void {
    const bytes = Buffer.from(
      `${JSON.stringify({ ...value, observedAt: new Date().toISOString() })}\n`,
    );
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("Voice record exceeds 1 MiB");
    if (this.damaged.has(fd)) throw new Error("Recording has an unrecoverable partial write");
    const before = fstatSync(fd).size;
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset);
        if (written <= 0) throw new Error("Voice recording write made no progress");
        offset += written;
      }
      if (durable) fsyncSync(fd);
    } catch (error) {
      // A failed partial write must not corrupt the next gap/end JSONL record.
      try {
        ftruncateSync(fd, before);
      } catch {
        this.damaged.add(fd);
      }
      throw error;
    }
  }

  openThread(threadId: string): number {
    if (this.closed) throw new Error("Voice recorder is closed");
    const existing = this.files.get(threadId);
    if (existing !== undefined) return existing;
    if (this.files.size >= 128)
      throw new Error("Recording limit reached: 128 conversations per run");
    const name = /^[A-Za-z0-9_-]{1,128}$/.test(threadId)
      ? threadId
      : createHash("sha256").update(threadId).digest("hex");
    const path = join(this.directory, `${name}.jsonl`);
    const release = lockThread(join(this.directory, ".locks"), name);
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_RDWR |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077
      )
        throw new Error(`Unsafe recording file: ${path}`);
      let recovered = false;
      let interrupted = false;
      if (stat.size) {
        const prefix = Buffer.alloc(Math.min(stat.size, 16_384));
        readSync(fd, prefix, 0, prefix.length, 0);
        const newline = prefix.indexOf(10);
        if (newline < 0) throw new Error(`Missing recording header: ${path}`);
        const header = JSON.parse(prefix.subarray(0, newline).toString("utf8"));
        if (
          header.type !== "voice_transcript" ||
          header.format !== "agentvoice" ||
          header.workspace !== this.workspace ||
          header.threadId !== threadId
        )
          throw new Error(`Recording identity mismatch: ${path}`);
        const tail = Buffer.alloc(Math.min(stat.size, MAX_RECORD_BYTES));
        readSync(fd, tail, 0, tail.length, stat.size - tail.length);
        if (tail.at(-1) !== 10) {
          const last = tail.lastIndexOf(10);
          if (last < 0) throw new Error(`Oversized unfinished recording entry: ${path}`);
          ftruncateSync(fd, stat.size - tail.length + last + 1);
          recovered = true;
        }
        const complete = tail.subarray(0, tail.lastIndexOf(10)).toString("utf8").split("\n").at(-1);
        try {
          interrupted = JSON.parse(complete ?? "{}").type !== "recording.ended";
        } catch {
          interrupted = true;
        }
      } else {
        this.write(fd, {
          type: "voice_transcript",
          format: "agentvoice",
          workspace: this.workspace,
          threadId,
        });
      }
      this.write(fd, { type: "recording.started", recordingId: this.recordingId }, true);
      if (recovered)
        this.write(fd, { type: "recording.gap", reason: "unfinished_record_recovered" }, true);
      if (interrupted)
        this.write(fd, { type: "recording.gap", reason: "previous_recording_interrupted" }, true);
      const directoryFd = openSync(this.directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      this.files.set(threadId, fd);
      this.releases.set(threadId, release);
      this.opened(path);
      return fd;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      release();
      this.releases.delete(threadId);
      this.files.delete(threadId);
      throw error;
    }
  }

  accept(value: unknown): void {
    const frame = recordedVoiceFrame.parse(value);
    const identity = JSON.stringify([frame.data.instanceId, frame.data.generation]);
    if (this.identity !== undefined && this.identity !== identity) this.gap("runtime_replaced");
    this.identity = identity;
    // Promoted work references are not voice messages; retain session boundary items.
    if ("item" in frame.data && frame.data.item.type === "bemItemPromoted") return;
    const fd = this.openThread(frame.data.threadId);
    this.write(fd, frame, frame.event === "voice.item.completed");
  }

  gap(reason: string): void {
    for (const fd of this.files.values()) this.write(fd, { type: "recording.gap", reason }, true);
  }

  close(reason: "stopped" | "disconnected" | "error"): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const fd of this.files.values()) {
      try {
        this.write(fd, { type: "recording.ended", recordingId: this.recordingId, reason }, true);
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          closeSync(fd);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.files.clear();
    for (const release of this.releases.values()) release();
    this.releases.clear();
    if (errors.length) throw new AggregateError(errors, "Could not finish voice recording");
  }
}
