import { ControlSocket } from "../ipc/control-client.ts";
import { FRONTEND_VERSION, type FrontendObservation, observationSchema } from "./protocol.ts";

export async function observeFrontend(path: string, changed: (state: FrontendObservation) => void) {
  const socket = await ControlSocket.connect(path, FRONTEND_VERSION, (frame) => {
    if (frame["type"] !== "observation") throw new Error("Unexpected frontend observation");
    changed(observationSchema.parse(frame["observation"]));
  });
  try {
    const initial = observationSchema.parse(await socket.request("observe"));
    return { socket, initial };
  } catch (error) {
    socket.close();
    throw new Error(
      "AgentVoice server cannot provide call observation; update/restart the waiting server before using the composition",
      { cause: error },
    );
  }
}
