import { randomUUID } from "node:crypto";
import { acquireAttachment } from "../../src/attachment/bootstrap.ts";
import type { AttachmentTicket } from "../../src/attachment/gateway.ts";
import type { ReadableControlProtocol } from "../../src/control/discovery.ts";

export type AgentTarget = {
  instanceId: string;
  generation: number;
  workspace: string;
  threadId: string;
  controlProtocolVersion: ReadableControlProtocol;
};
export type AgentOperation =
  | { action: "send"; text: string }
  | { action: "steer"; text: string; turnId: string }
  | { action: "interrupt"; turnId: string };

export class AgentSendError extends Error {
  constructor(
    message: string,
    readonly delivery: "not-sent" | "rejected" | "unknown",
  ) {
    super(message);
  }
}

/** Credentials and native RPC stay on the host, behind the stock TUI's exact-thread gateway. */
export async function sendAgentOperation(
  stateDir: string,
  target: AgentTarget,
  operation: AgentOperation,
  current: () => boolean,
): Promise<string | undefined> {
  if (!current()) throw new AgentSendError("The call changed. Nothing was sent.", "not-sent");
  let ticket: AttachmentTicket;
  try {
    ticket = await acquireAttachment(
      stateDir,
      target.workspace,
      target.threadId,
      target,
      target.controlProtocolVersion,
    );
  } catch {
    throw new AgentSendError("Cannot attach to the current Agent. Nothing was sent.", "not-sent");
  }
  return dispatchAgentOperation(ticket, operation, current);
}

export async function dispatchAgentOperation(
  ticket: AttachmentTicket,
  operation: AgentOperation,
  current: () => boolean,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const headers = { Authorization: `Bearer ${ticket.token}` };
  const watcher = new WebSocket(`${ticket.url}/watch`, { headers });
  let socket: WebSocket | undefined;
  let sent = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const fail = () => {
        finished = true;
        reject(
          new AgentSendError(
            sent
              ? "Delivery is unknown. Check the transcript before trying again."
              : "Agent connection unavailable. Nothing was sent.",
            sent ? "unknown" : "not-sent",
          ),
        );
      };
      timer = setTimeout(fail, timeoutMs);
      watcher.addEventListener("error", fail);
      watcher.addEventListener("close", fail);
      watcher.addEventListener(
        "message",
        ({ data }) => {
          if (finished) return;
          try {
            if (typeof data !== "string" || JSON.parse(data).ready !== true) throw new Error();
            socket = new WebSocket(ticket.url, { headers });
            socket.addEventListener("error", fail);
            socket.addEventListener("close", fail);
            socket.addEventListener("open", () =>
              socket!.send(
                JSON.stringify({
                  id: "initialize",
                  method: "initialize",
                  params: {
                    clientInfo: { name: "agentvoice-web", version: "0.1.0" },
                    capabilities: { experimentalApi: true },
                  },
                }),
              ),
            );
            socket.addEventListener("message", ({ data }) => {
              if (finished) return;
              try {
                if (typeof data !== "string" || Buffer.byteLength(data) > 4 * 1024 * 1024)
                  throw new Error();
                const frame = JSON.parse(data);
                // Native questions remain pending for the stock TUI; this client never answers them.
                if (frame.method || (frame.id !== "initialize" && frame.id !== "operation")) return;
                if (frame.error) {
                  reject(
                    new AgentSendError(
                      "Codex rejected the request. Check the current turn and try again.",
                      "rejected",
                    ),
                  );
                  return;
                }
                if (!Object.hasOwn(frame, "result")) throw new Error();
                if (frame.id === "operation" && sent) {
                  if (operation.action === "interrupt") resolve(undefined);
                  else {
                    const id =
                      operation.action === "send" ? frame.result?.turn?.id : frame.result?.turnId;
                    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id))
                      throw new Error();
                    resolve(id);
                  }
                  return;
                }
                if (frame.id !== "initialize" || sent) return;
                if (!current()) {
                  reject(
                    new AgentSendError("The call or turn changed. Nothing was sent.", "not-sent"),
                  );
                  return;
                }
                socket!.send(JSON.stringify({ method: "initialized", params: {} }));
                const method =
                  operation.action === "send"
                    ? "turn/start"
                    : operation.action === "steer"
                      ? "turn/steer"
                      : "turn/interrupt";
                const params =
                  operation.action === "interrupt"
                    ? { threadId: ticket.threadId, turnId: operation.turnId }
                    : {
                        threadId: ticket.threadId,
                        input: [{ type: "text", text: operation.text, text_elements: [] }],
                        clientUserMessageId: randomUUID(),
                        ...(operation.action === "steer"
                          ? { expectedTurnId: operation.turnId }
                          : {}),
                      };
                sent = true;
                socket!.send(JSON.stringify({ id: "operation", method, params }));
              } catch {
                fail();
              }
            });
          } catch {
            fail();
          }
        },
        { once: true },
      );
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    socket?.close(1000);
    watcher.close(1000);
  }
}
