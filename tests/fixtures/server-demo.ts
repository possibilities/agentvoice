/** Real two-process terminal demo with fake Codex/media; never opens hardware or inference. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { runConsoleHost } from "../../src/console/host.ts";
import type { VoiceHost, VoiceState } from "../../src/console/state.ts";
import { frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";
import { stateDirectory } from "../../src/paths.ts";
import { hostHarness } from "./host-harness.ts";

const workspace = realpathSync(process.cwd());
const server = new VoiceServer(
  frontendSocketPath(stateDirectory(process.env, homedir()), workspace),
  async (changed) => {
    const h = hostHarness();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    let host: VoiceHost | undefined;
    let run: Promise<void> | undefined;
    const waiting: VoiceState = {
      available: false,
      phase: "waiting-ready",
      mic: { muted: false, effectiveMuted: true },
      speaker: { muted: false, effectiveMuted: true },
    };
    return {
      state: () => ({ ...(host?.state() ?? waiting), codingActivity: "unknown" as const }),
      start: () => {
        run = runConsoleHost(h.config, "terminal-demo", {
          mediaFactory: h.mediaFactory,
          runtime: h.runtimeOptions,
          onStarted: started.resolve,
          observe: async (bindings) => {
            host = bindings;
            return {
              done: ended.promise,
              refresh: changed,
              cancelInputs() {},
              shutdown: async () => {
                ended.resolve();
              },
            };
          },
        });
        void run.catch(started.reject);
        return started.promise;
      },
      command: (command) => {
        if (command.action === "mute") host?.setMuted(command.target, command.muted);
        else if (command.action === "hold") host?.beginUnmute("mic", "pointer");
        else host?.releaseUnmute("mic", "pointer");
      },
      close: async () => {
        await host?.shutdown();
        ended.resolve();
        await run;
        await h.cleanup();
        console.log("CALL CLOSED: audio and fake Codex stopped; waiting");
      },
    };
  },
);
const ended = Promise.withResolvers<void>();
const stop = () => ended.resolve();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await server.start();
  console.log("WAITING: no call, no microphone or inference");
  await ended.promise;
} finally {
  await server.close();
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
