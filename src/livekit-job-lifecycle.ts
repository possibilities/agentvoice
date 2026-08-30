interface JobResourceTelemetry {
  emit(source: "livekit" | "fx", type: string, data?: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export class LiveKitJobResourceStopper {
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly options: {
      stopResource(): Promise<void>;
      telemetry: JobResourceTelemetry;
      roomName(): string | null;
      onStopping(): void;
    },
  ) {}

  stop(reason: string): Promise<void> {
    this.stopping ??= this.run(reason);
    return this.stopping;
  }

  async runGuarded<T>(failureReason: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      try {
        await this.stop(failureReason);
      } catch (stopError) {
        throw new AggregateError(
          [asError(error), asError(stopError)],
          "LiveKit agent entry failed and resource cleanup also failed",
        );
      }
      throw error;
    }
  }

  private async run(reason: string): Promise<void> {
    this.options.onStopping();
    let stopError: Error | null = null;
    try {
      await this.options.stopResource();
    } catch (error) {
      stopError = error instanceof Error ? error : new Error(String(error));
      await this.options.telemetry
        .emit("fx", "fx.stop.error", { message: stopError.message })
        .catch(() => {});
    }
    await this.options.telemetry.emit("livekit", "livekit.job.stopped", {
      room: this.options.roomName(),
      reason,
      status: stopError ? "failed" : "completed",
      error: stopError?.message ?? null,
      runtimeProcessExitPending: true,
    });
    await this.options.telemetry.flush();
    if (stopError) throw stopError;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
