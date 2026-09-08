/** Call-owning loopback browser frontend for Android/Termux and desktop proofs. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { connectFrontend } from "../frontend/client.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { type FrontendState, frontendSocketPath } from "../frontend/protocol.ts";
import { stateDirectory } from "../paths.ts";
import { BrowserMediaServer } from "./server.ts";

export interface BrowserFrontendOptions {
  stateDir?: string;
  open?: (url: string) => void | Promise<void>;
  write?: (line: string) => void;
  signal?: AbortSignal;
}

export async function runBrowserFrontend(
  workspace?: string,
  options: BrowserFrontendOptions = {},
): Promise<void> {
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let currentSessionId: string | undefined;
  let latestState: FrontendState | undefined;
  let ownerOpen = false;
  const finished = Promise.withResolvers<void>();

  const publishState = () => {
    if (!currentSessionId || !latestState) return;
    gateway.send({
      type: "state",
      sessionId: currentSessionId,
      mic: latestState.mic,
      speaker: latestState.speaker,
    });
  };
  const fromRuntime = (message: ServerMediaMessage) => {
    if (message.type === "prepare") {
      currentSessionId = message.sessionId;
      gateway.send(message);
      publishState();
      return;
    }
    gateway.send(message);
    if (message.type === "close" && currentSessionId === message.sessionId)
      currentSessionId = undefined;
  };
  const fromBrowser = (message: ClientMediaMessage) => {
    if (!client || message.sessionId !== currentSessionId) return;
    if (message.type === "mute")
      client.command({ action: "mute", target: message.target, muted: message.muted });
    else if (message.type === "hold" || message.type === "release")
      client.command({ action: message.type });
    else client.clientMedia(message);
  };

  const gateway = new BrowserMediaServer({
    onOwnerOpen: async () => {
      if (ownerOpen) throw new Error("browser voice owner is already open");
      ownerOpen = true;
      client = await connectFrontend(
        frontendSocketPath(options.stateDir ?? stateDirectory(process.env, homedir()), workspace),
        () => {
          queueMicrotask(() => {
            if (!client) return;
            latestState = client.state();
            publishState();
          });
        },
        randomUUID(),
        { onMedia: fromRuntime },
      );
      latestState = client.state();
      publishState();
      void client.done.then(() => finished.resolve());
    },
    onClientMessage: fromBrowser,
    onOwnerClosed: async () => {
      ownerOpen = false;
      try {
        await client?.close();
      } finally {
        finished.resolve();
      }
    },
  });
  gateway.start();
  const stop = () => finished.resolve();
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  try {
    if (!options.signal?.aborted) {
      (options.write ?? console.log)(`Open ${gateway.url} and tap Start voice.`);
      await (options.open ?? openBrowser)(gateway.url);
    }
    await finished.promise;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    for (const signal of signals) process.off(signal, stop);
    await client?.close();
    await gateway.close();
  }
}

async function openBrowser(url: string): Promise<void> {
  const argv = Bun.which("termux-open-url")
    ? [Bun.which("termux-open-url")!, url]
    : Bun.which("am")
      ? [Bun.which("am")!, "start", "-a", "android.intent.action.VIEW", "-d", url]
      : process.platform === "darwin"
        ? ["/usr/bin/open", url]
        : undefined;
  if (!argv) return;
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
}
