import { isAbsolute } from "node:path";
import { z } from "zod";
import { discoverController } from "../control/discovery.ts";

export const attachmentTargetSchema = z
  .object({
    instanceId: z.string().min(1),
    generation: z.number().int().positive(),
    threadId: z.string().min(1),
    workspace: z.string().refine(isAbsolute),
  })
  .strict();
export const attachmentTicketSchema = z
  .object({
    threadId: z.string().min(1),
    workspace: z.string().refine(isAbsolute),
    codex: z.string().refine(isAbsolute),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    url: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+$/),
  })
  .strict();

export async function acquireAttachment(stateDir: string, workspace: string, threadId?: string) {
  const { descriptor, status } = await discoverController(stateDir, workspace, threadId);
  const target = attachmentTargetSchema.parse({
    instanceId: status.instanceId,
    generation: status.generation,
    threadId: status.threadId,
    workspace,
  });
  const response = await fetch(new URL("/tui/attach", descriptor.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(target),
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      "Attachment unavailable; launch with --allow-tui-attach and select the current live thread",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid attachment ticket");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) throw new Error("Invalid attachment ticket");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const ticket = attachmentTicketSchema.parse(JSON.parse(text));
  if (ticket.threadId !== target.threadId || ticket.workspace !== workspace)
    throw new Error("Attachment identity changed");
  return ticket;
}
