import { realpathSync } from "node:fs";
import { parseMcpConfigCommand } from "../main.ts";
import {
  attachmentIdentitySchema,
  MAX_ATTACHMENT_FRAME,
  streamAttachmentSession,
} from "./session.ts";

/** Internal SSH stdout transport, deliberately absent from the voice/WSS gateway. */
export async function runAttachmentBridge(argv: string[], stateDir: string) {
  if (argv.length && (argv.length !== 2 || argv[0] !== "--workspace"))
    throw new Error("Invalid attachment bridge selection");
  const selection = argv.length ? parseMcpConfigCommand(argv) : undefined;
  if (selection?.help) throw new Error("Invalid attachment bridge selection");
  const abort = new AbortController();
  const stop = () => abort.abort();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  process.stdout.on("error", stop);
  try {
    await streamAttachmentSession(
      stateDir,
      selection?.workspace,
      async (frame) => {
        const line = `${JSON.stringify(frame)}\n`;
        if (Buffer.byteLength(line) > MAX_ATTACHMENT_FRAME)
          throw new Error("Attachment frame exceeds limit");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Attachment reader stalled")), 5000);
          process.stdout.write(line, (error) => (error ? reject(error) : resolve()));
        }).finally(() => clearTimeout(timer));
      },
      abort.signal,
    );
    return 0;
  } finally {
    for (const signal of signals) process.off(signal, stop);
    process.stdout.off("error", stop);
  }
}

/** Bootstrap again on the backend, but refuse a successor instance or generation. */
export async function runPinnedAttachment(argv: string[], stateDir: string) {
  if (argv.length !== 1 || Buffer.byteLength(argv[0]!) > 8192)
    throw new Error("Invalid attachment identity");
  const identity = attachmentIdentitySchema.parse(JSON.parse(argv[0]!));
  if (realpathSync(identity.workspace) !== identity.workspace)
    throw new Error("Attachment workspace changed");
  const { runAttachment } = await import("./launcher.ts");
  return runAttachment(identity, stateDir, {
    workspace: identity.workspace,
    threadId: identity.threadId,
    instanceId: identity.instanceId,
    generation: identity.generation,
  });
}
