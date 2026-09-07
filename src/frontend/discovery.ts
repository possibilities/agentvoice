import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { safeAncestors } from "../private-files.ts";
import { FRONTEND_VERSION, frontendSocketPath } from "./protocol.ts";

const identity = z
  .object({ busy: z.boolean(), workspace: z.string().nullable(), threadId: z.string().nullable() })
  .strict();
export async function discoverServer(
  stateDir: string,
  workspace?: string,
): Promise<z.infer<typeof identity> | undefined> {
  const path = frontendSocketPath(stateDir, workspace);
  safeAncestors(dirname(path));
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isSocket() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error("Unsafe AgentVoice server socket");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let text = "";
    const timer = setTimeout(() => finish(new Error("AgentVoice discovery timed out")), 1500);
    function finish(error?: Error, value?: z.infer<typeof identity>) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ v: FRONTEND_VERSION, type: "request", id: "discover", method: "discover" })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 16_384)
        return finish(new Error("Oversized server discovery response"));
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(text.slice(0, newline));
        if (
          response.v !== FRONTEND_VERSION ||
          response.type !== "response" ||
          response.id !== "discover" ||
          response.ok !== true
        )
          throw new Error(
            "Server cannot resolve attachment workspace; pass --workspace or update the server",
          );
        finish(undefined, identity.parse(response.result));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? undefined : error),
    );
    socket.on("end", () => finish(new Error("Server closed discovery before replying")));
  });
}
