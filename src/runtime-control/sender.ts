import { IPC_VERSION, type IpcMessage } from "./protocol.ts";

type Outbound = Omit<IpcMessage, "version" | "generation">;

/** Transient observation must not consume the queue reserved for runtime control. */
export function runtimeSender(options: {
  generation: number;
  connected(): boolean;
  write(message: IpcMessage, done: (error: Error | null) => void): void;
  failed(): void;
}) {
  let pending = 0;
  let failed = false;
  let gap: Outbound | undefined;
  function send(message: Outbound): void {
    if (!options.connected()) return;
    if (pending >= 16 && message.method === "conversation") {
      const notification = message.params as { revision: number };
      gap = {
        method: "conversation",
        params: {
          event: "conversation.gap",
          revision: notification.revision,
          data: { threadId: null, reason: "backpressure" },
        },
      };
      return;
    }
    // Voice completions contain canonical text; never silently discard them as transient UI.
    if (pending >= 16 && message.method === "state") return;
    if (
      pending >= 16 &&
      message.method === "voice" &&
      (message.params as { event?: string }).event === "voice.item.transcript.delta"
    )
      return;
    if (pending >= 64) {
      failed = true;
      options.failed();
      return;
    }
    pending++;
    let finished = false;
    const done = (error: Error | null) => {
      if (finished) return;
      finished = true;
      pending--;
      if (error) {
        failed = true;
        options.failed();
      } else if (gap && pending < 16 && options.connected()) {
        const queued = gap;
        gap = undefined;
        send(queued);
      }
    };
    try {
      options.write({ ...message, version: IPC_VERSION, generation: options.generation }, done);
    } catch {
      done(new Error("Runtime IPC write failed"));
    }
  }
  return {
    get pending() {
      return pending;
    },
    send,
    async drain(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (pending > 0 && !failed && options.connected() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (pending > 0 || failed || !options.connected())
        throw new Error("Runtime IPC did not drain");
    },
  };
}
