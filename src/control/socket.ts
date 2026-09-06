import { join } from "node:path";
import { JsonSocketServer } from "../ipc/json-socket.ts";
import { dispatchControl, errorResponse } from "./contract.ts";
import { CONTROL_PROTOCOL_VERSION, type ControlBackend } from "./types.ts";

/** Control requests share dispatch with MCP; event subscriptions use another endpoint. */
export class ControlSocketServer extends JsonSocketServer {
  constructor(path: string, backend: ControlBackend) {
    super(path, {
      version: CONTROL_PROTOCOL_VERSION,
      async handle(request, peer) {
        try {
          const result = await dispatchControl(backend, request.method, request.params);
          peer.send({
            v: CONTROL_PROTOCOL_VERSION,
            type: "response",
            id: request.id,
            ok: true,
            result,
          });
        } catch (error) {
          peer.send(errorResponse(request.id, error));
        }
      },
    });
  }
}
export function controlSocketPath(stateDir: string, instanceId: string): string {
  return join(stateDir, "control", `${Bun.hash(instanceId).toString(16)}.sock`);
}
