/**
 * The voice server: one codex app-server child, one orchestrator agent, one
 * WebSocket client, at most one realtime (WebRTC) voice session.
 *
 * The client's audio flows peer-to-peer to the voice agent; this server only
 * coordinates: it relays the client's SDP offer into `thread/realtime/start`
 * and the answer back out. The voice↔orchestrator handoff happens entirely
 * inside app-server. Session lifecycle lives in session.ts; this file is
 * wiring: process supervision, the thread, and the WebSocket.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AppServer, AppServerError } from "./appserver.ts";
import {
  PROMPT_FILES,
  promptFilenames,
  readPrompts,
  type ServerConfig,
  stateDirectory,
} from "./config.ts";
import { realtimeParams, threadParams } from "./params.ts";
import {
  CLOSE_BUSY,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "./protocol.ts";
import { VoiceSessionManager } from "./session.ts";

const RESTART_BACKOFF_INITIAL_MS = 500;
const RESTART_BACKOFF_CAP_MS = 30_000;
const HEALTHY_UPTIME_MS = 60_000;
const SHUTDOWN_STOP_TIMEOUT_MS = 1_500;

export async function runServer(config: ServerConfig, version: string): Promise<void> {
  const stateDir = stateDirectory(process.env, homedir());
  const appServerCwd = join(stateDir, "app-server");
  mkdirSync(appServerCwd, { recursive: true, mode: 0o700 });
  mkdirSync(config.orchestrator.workspace, { recursive: true, mode: 0o700 });

  // Read once at boot: prompts prime each agent identically for every thread
  // and every voice session of this run.
  const prompts = await readPrompts(config.configDir);
  const foundPrompts = promptFilenames(prompts);

  const debugLog = config.debug
    ? (line: string) =>
        console.error(`[debug] ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)
    : undefined;

  let appServer: AppServer | null = null;
  let threadId: string | null = null;
  let threadReady = false;
  let client: ServerWebSocket<undefined> | null = null;
  let restartFailures = 0;
  let shuttingDown = false;

  function send(payload: ServerMessage): void {
    if (client && client.readyState === 1) client.send(JSON.stringify(payload));
  }

  function sendReady(): void {
    if (!client || !threadReady || !threadId) return;
    send({
      type: "ready",
      protocol: PROTOCOL_VERSION,
      threadId,
      workspace: config.orchestrator.workspace,
      model: config.orchestrator.model ?? null,
      effort: config.orchestrator.effort ?? null,
      voiceModel: config.voice.model ?? null,
      voice: config.voice.name ?? null,
      prompts: foundPrompts,
    });
  }

  const sessions = new VoiceSessionManager({
    sendAnswer: (sdp) => send({ type: "answer", sdp }),
    sendClosed: (reason) => send({ type: "closed", ...(reason ? { reason } : {}) }),
    sendFailed: (message) => send({ type: "error", code: "realtime-failed", message, fatal: true }),
    sendReady,
    startRealtime(realtimeSessionId, sdp) {
      if (!appServer || !threadId) {
        return Promise.reject(new AppServerError("app-server is not running"));
      }
      return appServer
        .request(
          "thread/realtime/start",
          realtimeParams(config, prompts, threadId, realtimeSessionId, sdp),
        )
        .then(() => {});
    },
    stopRealtime() {
      if (!appServer || !threadId) {
        return Promise.reject(new AppServerError("app-server is not running"));
      }
      return appServer.request("thread/realtime/stop", { threadId }).then(() => {});
    },
    debug: debugLog,
  });

  function extractThreadId(result: unknown): string {
    const shape = result as { thread?: { id?: string }; threadId?: string };
    const id = shape?.thread?.id ?? shape?.threadId;
    if (!id) throw new AppServerError("app-server returned no thread id");
    return id;
  }

  async function openThread(server: AppServer): Promise<string> {
    if (threadId) {
      try {
        return extractThreadId(
          await server.request("thread/resume", {
            threadId,
            excludeTurns: true,
            ...threadParams(config, prompts, "resume"),
          }),
        );
      } catch (error) {
        console.error(
          `thread/resume failed (${error instanceof Error ? error.message : String(error)}); starting a fresh thread`,
        );
      }
    }
    return extractThreadId(
      await server.request("thread/start", threadParams(config, prompts, "start")),
    );
  }

  async function connectAppServer(): Promise<void> {
    const server = new AppServer({
      codexBin: config.codex,
      processCwd: appServerCwd,
      clientVersion: version,
      onNotification: handleNotification,
      onExit: (info) => handleAppServerExit(server, info),
      debug: debugLog,
    });
    appServer = server;
    try {
      await server.start();
      threadId = await openThread(server);
    } catch (error) {
      appServer = null;
      const stderr = server.recentStderr;
      await server.stop().catch(() => {});
      if (error instanceof AppServerError && stderr) {
        throw new AppServerError(`${error.message}\napp-server stderr:\n${stderr}`);
      }
      throw error;
    }
    threadReady = true;
    sendReady();
  }

  function handleAppServerExit(
    server: AppServer,
    { code, expected }: { code: number | null; expected: boolean },
  ): void {
    if (appServer !== server) return; // an instance we already replaced or tore down
    appServer = null;
    threadReady = false;
    const hadSession = sessions.hasSession;
    sessions.reset(); // every session died with the child
    if (shuttingDown || expected) return;
    if (hadSession) send({ type: "closed", reason: "app-server-exited" });
    // A child that dies young counts as a failure even if it spawned cleanly,
    // so a crash loop backs off instead of restarting hot.
    if (Date.now() - server.spawnedAt > HEALTHY_UPTIME_MS) restartFailures = 0;
    else restartFailures++;
    const delay = Math.min(
      RESTART_BACKOFF_INITIAL_MS * 2 ** restartFailures,
      RESTART_BACKOFF_CAP_MS,
    );
    console.error(`app-server exited unexpectedly (code ${code}); restarting in ${delay}ms`);
    setTimeout(() => void restart(), delay);
  }

  async function restart(): Promise<void> {
    if (shuttingDown) return;
    try {
      await connectAppServer();
      restartFailures = 0;
      console.error("app-server restarted; orchestrator agent re-established");
    } catch (error) {
      restartFailures++;
      const delay = Math.min(
        RESTART_BACKOFF_INITIAL_MS * 2 ** restartFailures,
        RESTART_BACKOFF_CAP_MS,
      );
      console.error(
        `app-server restart failed (${error instanceof Error ? error.message : String(error)}); retrying in ${delay}ms`,
      );
      setTimeout(() => void restart(), delay);
    }
  }

  function handleNotification(method: string, params: Record<string, unknown>): void {
    if (!method.startsWith("thread/realtime/")) return;
    if (params["threadId"] !== undefined && params["threadId"] !== threadId) return;
    sessions.handleNotification(method, params);
  }

  function handleClientMessage(text: string): void {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      send({ type: "error", code: parsed.code, message: parsed.error, fatal: false });
      return;
    }
    if (!threadReady || !appServer || !threadId) {
      send({
        type: "error",
        code: "not-ready",
        message: "no orchestrator agent yet; wait for ready",
        fatal: false,
      });
      return;
    }
    sessions.handleOffer(parsed.message.sdp);
  }

  // Boot fails fast: the operator is present. Later child exits are supervised.
  await connectAppServer();

  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        return server.upgrade(request)
          ? undefined
          : new Response("websocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/") {
        return Response.json({
          name: "agentvoicenext",
          version,
          protocol: PROTOCOL_VERSION,
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // Audio flows peer-to-peer, so the socket is legitimately silent for
      // minutes; a short idle timeout would sever healthy sessions.
      idleTimeout: 120,
      sendPings: true,
      maxPayloadLength: 1 << 20,
      open(ws: ServerWebSocket<undefined>) {
        if (client) {
          ws.close(CLOSE_BUSY, "another client is connected");
          return;
        }
        client = ws;
        debugLog?.("client connected");
        sendReady();
      },
      message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
        if (ws !== client) return;
        handleClientMessage(typeof raw === "string" ? raw : raw.toString());
      },
      close(ws: ServerWebSocket<undefined>) {
        if (ws !== client) return;
        client = null;
        debugLog?.("client disconnected");
        sessions.handleClientGone();
      },
    },
  });

  const orDefault = (value: string | undefined) => value ?? "(codex default)";
  const { orchestrator, voice } = config;
  console.log(`agentvoicenext server listening on ws://127.0.0.1:${config.port}/ws`);
  console.log(`  workspace       ${orchestrator.workspace}`);
  console.log(`  thread          ${threadId}`);
  console.log(
    `  orchestrator    ${orDefault(orchestrator.model)}  effort ${orDefault(orchestrator.effort)}`,
  );
  console.log(
    `  voice agent     ${orDefault(voice.model)}  voice ${voice.name ?? "(upstream default)"}`,
  );
  console.log(
    `  sandbox         ${orchestrator.permissions ?? orchestrator.sandbox}  approvals ${orchestrator.approvalPolicy}`,
  );
  console.log(
    `  prompts         ${foundPrompts.length > 0 ? foundPrompts.join(" ") : "(none)"}  in ${config.configDir}`,
  );
  if (prompts.orchestratorBaseInstructions !== undefined) {
    console.error(
      `warning: ${PROMPT_FILES.orchestratorBaseInstructions} replaces codex's entire system prompt, including its tool discipline`,
    );
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("shutting down");
    try {
      client?.close(1001, "server shutting down");
    } catch {
      // client may already be gone
    }
    await Promise.race([
      sessions.shutdown(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_STOP_TIMEOUT_MS)),
    ]);
    httpServer.stop(true);
    if (appServer) await appServer.stop().catch(() => {});
  }

  await new Promise<void>((resolve) => {
    const onSignal = () => void shutdown().then(resolve);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
