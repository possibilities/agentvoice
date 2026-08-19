/** Interactive owner-side half of pairing, carried only over the private unix listener. */
import { createConnection } from "node:net";
import { createInterface } from "node:readline/promises";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlFrame,
  parseServerFrame,
  type ServerFrame,
} from "../core/control-protocol.ts";

export interface PairWithServerOptions {
  write?(line: string): void;
  confirm?(code: string, deviceName: string): Promise<boolean>;
  timeoutMs?: number;
}

export async function pairWithServer(
  socketPath: string,
  options: PairWithServerOptions = {},
): Promise<number> {
  const write = options.write ?? console.log;
  const confirm = options.confirm ?? confirmInTerminal;
  const timeoutMs = options.timeoutMs ?? 130_000;
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffered = "";
    let settled = false;
    let promptedSession: string | null = null;
    let admitted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: number, message?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (message) write(message);
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    timer = setTimeout(() => finish(1, "pairing timed out"), timeoutMs);
    timer.unref?.();

    const handle = (frame: ServerFrame): void => {
      if (frame.type === "state" && !admitted) {
        admitted = true;
        socket.write(encodeControlFrame({ type: "pairing-open" }));
        return;
      }
      if (frame.type === "reject") {
        finish(1, `Server refused pairing: ${frame.reason}`);
        return;
      }
      if (frame.type !== "pairing-state") return;
      switch (frame.status) {
        case "open":
          write("Pairing window open; open AgentVoice Remote on the phone.");
          return;
        case "awaiting-confirmation": {
          if (
            !frame.sessionId ||
            !frame.code ||
            !frame.deviceName ||
            promptedSession === frame.sessionId
          )
            return;
          promptedSession = frame.sessionId;
          write(`Compare ${frame.code} on this Mac and ${frame.deviceName}.`);
          void confirm(frame.code, frame.deviceName)
            .then((approved) => {
              if (settled) return;
              socket.write(
                encodeControlFrame(
                  approved
                    ? { type: "pairing-local-confirm", sessionId: frame.sessionId! }
                    : { type: "pairing-cancel" },
                ),
              );
            })
            .catch((error) => {
              fail(error);
            });
          return;
        }
        case "complete":
          finish(0, `${frame.deviceName ?? "Remote console"} paired.`);
          return;
        case "failed":
        case "cancelled":
          finish(1, frame.message ?? `pairing ${frame.status}`);
          return;
      }
    };

    socket.once("connect", () => {
      socket.write(
        encodeControlFrame({ type: "hello", protocol: CONTROL_PROTOCOL_VERSION, role: "ui" }),
      );
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > 64 * 1024) {
        finish(1, "Server sent an oversized pairing response");
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const frame = parseServerFrame(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (frame) handle(frame);
      }
    });
    socket.once("error", (error) => {
      fail(error);
    });
    socket.once("close", () => {
      if (!settled) finish(1, "Server closed before pairing completed");
    });
  });
}

async function confirmInTerminal(code: string, deviceName: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("pairing confirmation needs an interactive terminal");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Does ${deviceName} also show ${code}? [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
}
