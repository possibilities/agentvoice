import { ControlSocket } from "../ipc/control-client.ts";
import { FRONTEND_VERSION, type FrontendObservation, observationSchema } from "./protocol.ts";

export async function observeFrontend(path: string, changed: (state: FrontendObservation) => void) {
  let latest: FrontendObservation | undefined;
  let update = () => {};
  const socket = await ControlSocket.connect(path, FRONTEND_VERSION, (frame) => {
    if (frame["type"] !== "observation") throw new Error("Unexpected frontend observation");
    latest = observationSchema.parse(frame["observation"]);
    changed(latest);
    update();
  });
  try {
    const initial = observationSchema.parse(await socket.request("observe"));
    latest ??= initial;
    return {
      socket,
      initial,
      // Observation never reserves a call; the later call request owns admission.
      async waitUntilAvailable(
        options: { signal?: AbortSignal; timeoutMs?: number; waiting?: () => void } = {},
      ) {
        const ready = Promise.withResolvers<void>();
        const check = () => {
          if (options.signal?.aborted) ready.reject(new Error("Frontend connection cancelled"));
          else if (latest?.availability === "idle") ready.resolve();
          else if (latest?.availability === "connected")
            ready.reject(
              new Error(
                "AgentVoice server is busy; close its current client before starting another call",
              ),
            );
          else if (latest?.availability === "unavailable")
            ready.reject(
              new Error("AgentVoice server is unavailable; check agentvoice service status"),
            );
        };
        update = check;
        const timer = setTimeout(
          () => ready.reject(new Error("Timed out waiting for previous call cleanup")),
          options.timeoutMs ?? 30_000,
        );
        options.signal?.addEventListener("abort", check, { once: true });
        void socket.done.then(() =>
          ready.reject(
            socket.error() ?? new Error("AgentVoice server disconnected during cleanup"),
          ),
        );
        try {
          check();
          if (latest?.availability === "closing") options.waiting?.();
          await ready.promise;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", check);
          update = () => {};
        }
      },
    };
  } catch (error) {
    socket.close();
    throw new Error(
      "AgentVoice server cannot provide call observation; update/restart the waiting server before connecting",
      { cause: error },
    );
  }
}
