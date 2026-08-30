#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AgentServer, initializeLogger, ServerOptions } from "@livekit/agents";
import { LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS, LIVEKIT_NUM_IDLE_PROCESSES } from "./livekit-runtime.ts";

export async function runControlledLiveKitWorker(): Promise<void> {
  const controlToken = requiredEnvironment("AGENTVOICE_WORKER_CONTROL_TOKEN");
  initializeLogger({ pretty: true, level: "warn" });
  const server = new AgentServer(
    new ServerOptions({
      agent: requiredEnvironment("AGENTVOICE_WORKER_AGENT_PATH"),
      agentName: requiredEnvironment("AGENTVOICE_WORKER_AGENT_NAME"),
      wsURL: requiredEnvironment("LIVEKIT_URL"),
      apiKey: requiredEnvironment("LIVEKIT_API_KEY"),
      apiSecret: requiredEnvironment("LIVEKIT_API_SECRET"),
      host: "127.0.0.1",
      port: requiredPositiveIntegerEnvironment("AGENTVOICE_WORKER_HTTP_PORT"),
      logLevel: "warn",
      production: false,
      // A nonzero idle pool keeps every active executor inside ProcPool's
      // tracked watch tasks, which AgentServer.close() actually awaits.
      numIdleProcesses: LIVEKIT_NUM_IDLE_PROCESSES,
      shutdownProcessTimeout: LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS,
    }),
  );

  let shutdownPromise: Promise<void> | null = null;
  let shutdownError: Error | null = null;
  const requestShutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    process.stderr.write(`[agentvoice-worker] graceful shutdown requested (${reason})\n`);
    shutdownPromise = server.close().catch((error) => {
      shutdownError = error instanceof Error ? error : new Error(String(error));
    });
    return shutdownPromise;
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let authenticatedControlReceived = false;
  input.on("line", (line) => {
    if (line === controlToken) {
      authenticatedControlReceived = true;
      void requestShutdown("authenticated control channel");
      return;
    }
    shutdownError = new Error("worker received an invalid control message");
    void requestShutdown("invalid control message");
  });
  input.on("close", () => {
    if (!authenticatedControlReceived) void requestShutdown("control channel closed");
  });

  const onSigint = () => void requestShutdown("SIGINT");
  const onSigterm = () => void requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await server.run();
    if (shutdownPromise) await shutdownPromise;
    if (shutdownError) throw shutdownError;
  } finally {
    input.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function requiredPositiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runControlledLiveKitWorker();
}
