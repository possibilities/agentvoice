import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedDirectory } from "../private-files.ts";
import {
  type AttachmentFrame,
  type AttachmentIdentity,
  attachmentFrameSchema,
  MAX_ATTACHMENT_FRAME,
  MAX_TRANSCRIPT_BYTES,
} from "./session.ts";
import { attachmentSshArgv } from "./ssh.ts";

/** A desktop-only, disposable copy. The server's recording is never modified. */
export class AttachmentTranscript {
  readonly directory = mkdtempSync(join(tmpdir(), "agentvoice-attach-"));
  readonly path = join(this.directory, "voice.jsonl");
  private fd: number | undefined;
  private bytes = 0;
  constructor() {
    try {
      ownedDirectory(this.directory);
      this.fd = openSync(this.path, "wx", 0o600);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  append(line: string, identity: AttachmentIdentity) {
    if (this.fd === undefined) throw new Error("Attachment transcript is closed");
    const bytes = Buffer.from(`${line}\n`);
    if (
      line.includes("\n") ||
      bytes.length > 1024 * 1024 ||
      this.bytes + bytes.length > MAX_TRANSCRIPT_BYTES
    )
      throw new Error("Voice transcript exceeds the viewer limit");
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Invalid voice record");
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Invalid voice record");
    if (
      !this.bytes &&
      (record["type"] !== "voice_transcript" ||
        record["format"] !== "agentvoice" ||
        record["workspace"] !== identity.workspace ||
        record["threadId"] !== identity.threadId)
    )
      throw new Error("Voice transcript identity changed");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.fd, bytes, offset);
      if (!written) throw new Error("Voice transcript write stalled");
      offset += written;
    }
    this.bytes += bytes.length;
  }
  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Bounded NDJSON with progress deadlines; stderr is never interpreted as protocol. */
export async function readAttachmentFrames(
  stream: ReadableStream<Uint8Array>,
  receive: (frame: AttachmentFrame) => Promise<void>,
  signal: AbortSignal,
  timeoutMs = 15_000,
) {
  const reader = stream.getReader();
  let pending = Buffer.alloc(0);
  let deadline = Date.now() + timeoutMs;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Attachment stream timed out")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) {
        if (pending.length && !signal.aborted) throw new Error("Attachment stream ended mid-frame");
        return;
      }
      pending = Buffer.concat([pending, next.value]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        if (end > MAX_ATTACHMENT_FRAME) throw new Error("Attachment frame exceeds limit");
        let frame: AttachmentFrame;
        try {
          frame = attachmentFrameSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end))),
          );
        } catch {
          throw new Error("Invalid attachment stream; update AgentVoice on the backend host");
        }
        pending = pending.subarray(end + 1);
        if (signal.aborted) return;
        deadline = Date.now() + timeoutMs;
        await receive(frame);
      }
      if (pending.length > MAX_ATTACHMENT_FRAME) throw new Error("Attachment frame exceeds limit");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamRemoteAttachment(
  host: string,
  workspace: string | undefined,
  receive: (frame: AttachmentFrame) => Promise<void>,
  signal: AbortSignal,
) {
  const child = Bun.spawn(
    attachmentSshArgv(host, [
      "agentvoice",
      "__attach-bridge",
      ...(workspace ? ["--workspace", workspace] : []),
    ]),
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let diagnostic = "";
  const stderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      // Continue draining after the cap so a remote error cannot deadlock teardown.
      if (diagnostic.length < 4096)
        diagnostic += decoder.decode(chunk).slice(0, 4096 - diagnostic.length);
    }
  })();
  const stop = () => child.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) return;
    await readAttachmentFrames(child.stdout, receive, signal);
    const exit = await Promise.race([child.exited, Bun.sleep(2000).then(() => undefined)]);
    if (!signal.aborted && exit !== 0)
      throw new Error(
        `SSH attachment failed${exit === undefined ? " to exit" : ` (${exit})`}: ${diagnostic.trim() || "check the host and its AgentVoice installation"}`,
      );
  } finally {
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await child.exited;
      clearTimeout(timer);
    }
    await stderr;
  }
}
