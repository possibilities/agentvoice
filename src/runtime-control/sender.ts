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
  return {
    get pending() {
      return pending;
    },
    send(message: Outbound): void {
      if (!options.connected()) return;
      if (pending >= 16 && (message.method === "state" || message.method === "voice")) return;
      if (pending >= 64) {
        options.failed();
        return;
      }
      pending++;
      let finished = false;
      const done = (error: Error | null) => {
        if (finished) return;
        finished = true;
        pending--;
        if (error) options.failed();
      };
      try {
        options.write({ ...message, version: IPC_VERSION, generation: options.generation }, done);
      } catch {
        done(new Error("Runtime IPC write failed"));
      }
    },
  };
}
