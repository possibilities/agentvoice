import { appendFile } from "node:fs/promises";
import { defineAgent, type JobContext } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import { LiveKitJobResourceStopper } from "./livekit-job-lifecycle.ts";

export const LIVEKIT_SHUTDOWN_PROBE_AGENT_NAME = "agentvoice-shutdown-probe";
export const LIVEKIT_SHUTDOWN_PROBE_DELAY_MS = 400;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const markerPath = requiredEnvironment("AGENTVOICE_SHUTDOWN_PROBE_PATH");
    const stopper = new LiveKitJobResourceStopper({
      async stopResource() {
        await appendFile(markerPath, "resource-stop-started\n", "utf8");
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, LIVEKIT_SHUTDOWN_PROBE_DELAY_MS),
        );
        await appendFile(markerPath, "resource-stop-finished\n", "utf8");
      },
      telemetry: {
        async emit(_source, type, data = {}) {
          if (type === "livekit.job.stopped") {
            await appendFile(markerPath, `job-stopped:${String(data["status"])}\n`, "utf8");
          }
        },
        async flush() {
          await appendFile(markerPath, "telemetry-flushed\n", "utf8");
        },
      },
      roomName: () => ctx.room.name ?? null,
      onStopping: () => {},
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      void stopper
        .stop(`participant_disconnected:${participant.identity}`)
        .catch((error) => appendFile(markerPath, `resource-stop-error:${String(error)}\n`, "utf8"));
    });
    ctx.addShutdownCallback(async () => {
      await stopper.stop("framework_shutdown");
      await appendFile(markerPath, "callback-started\n", "utf8");
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, LIVEKIT_SHUTDOWN_PROBE_DELAY_MS),
      );
      await appendFile(markerPath, "callback-finished\n", "utf8");
    });
    await ctx.connect();
    await appendFile(markerPath, "ready\n", "utf8");
  },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
