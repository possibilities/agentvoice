import { describe, expect, test } from "bun:test";
import { LiveKitJobResourceStopper } from "../src/livekit-job-lifecycle.ts";

describe("LiveKit job resource shutdown", () => {
  test("runs resource cleanup and authenticated completion exactly once", async () => {
    const order: string[] = [];
    const telemetry = new FakeTelemetry(order);
    let stopCount = 0;
    const stopper = new LiveKitJobResourceStopper({
      async stopResource() {
        stopCount++;
        order.push("resource.stop");
        await Bun.sleep(5);
      },
      telemetry,
      roomName: () => "room-1",
      onStopping: () => order.push("stopping"),
    });

    await Promise.all([
      stopper.stop("participant_disconnected:evaluator"),
      stopper.stop("fallback"),
    ]);

    expect(stopCount).toBe(1);
    expect(order).toEqual([
      "stopping",
      "resource.stop",
      "telemetry:livekit.job.stopped",
      "telemetry.flush",
    ]);
    expect(telemetry.events).toEqual([
      {
        source: "livekit",
        type: "livekit.job.stopped",
        data: {
          room: "room-1",
          reason: "participant_disconnected:evaluator",
          status: "completed",
          error: null,
          runtimeProcessExitPending: true,
        },
      },
    ]);
  });

  test("reports a failed resource stop before rejecting", async () => {
    const order: string[] = [];
    const telemetry = new FakeTelemetry(order);
    const stopper = new LiveKitJobResourceStopper({
      stopResource: async () => {
        throw new Error("Fx would not stop");
      },
      telemetry,
      roomName: () => null,
      onStopping: () => {},
    });

    await expect(stopper.stop("framework_shutdown")).rejects.toThrow("Fx would not stop");
    expect(telemetry.events).toEqual([
      { source: "fx", type: "fx.stop.error", data: { message: "Fx would not stop" } },
      {
        source: "livekit",
        type: "livekit.job.stopped",
        data: {
          room: null,
          reason: "framework_shutdown",
          status: "failed",
          error: "Fx would not stop",
          runtimeProcessExitPending: true,
        },
      },
    ]);
    expect(order.at(-1)).toBe("telemetry.flush");
  });

  test("rolls back a ready resource when post-start initialization fails", async () => {
    const order: string[] = [];
    const telemetry = new FakeTelemetry(order);
    const stopper = new LiveKitJobResourceStopper({
      stopResource: async () => {
        order.push("resource.stop");
      },
      telemetry,
      roomName: () => "room-1",
      onStopping: () => order.push("stopping"),
    });

    await expect(
      stopper.runGuarded("entry_failed", async () => {
        order.push("resource.ready");
        order.push("post-start.initialization");
        throw new Error("identity telemetry failed");
      }),
    ).rejects.toThrow("identity telemetry failed");

    expect(order).toEqual([
      "resource.ready",
      "post-start.initialization",
      "stopping",
      "resource.stop",
      "telemetry:livekit.job.stopped",
      "telemetry.flush",
    ]);
    expect(telemetry.events.at(-1)).toMatchObject({
      type: "livekit.job.stopped",
      data: { reason: "entry_failed", status: "completed" },
    });
  });
});

class FakeTelemetry {
  readonly events: Array<{
    source: "livekit" | "fx";
    type: string;
    data: Record<string, unknown>;
  }> = [];

  constructor(private readonly order: string[]) {}

  async emit(
    source: "livekit" | "fx",
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    this.order.push(`telemetry:${type}`);
    this.events.push({ source, type, data });
  }

  async flush(): Promise<void> {
    this.order.push("telemetry.flush");
  }
}
