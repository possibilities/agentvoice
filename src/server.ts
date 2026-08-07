/**
 * The voice server: one codex app-server child, one orchestrator thread, one
 * WebSocket client, at most one realtime (WebRTC) voice session.
 *
 * The client's audio flows peer-to-peer to the voice model; this server only
 * coordinates: it relays the client's SDP offer into `thread/realtime/start`
 * and the answer back out. The voice↔orchestrator handoff happens entirely
 * inside app-server.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AppServer, AppServerError } from "./appserver.ts";
import { stateDirectory, type ServerConfig } from "./config.ts";

export const PROTOCOL_VERSION = 1;
export const CLOSE_BUSY = 4429;

/** Readiness is the `thread/realtime/started` notification, not the RPC ack. */
const REALTIME_START_TIMEOUT_MS = 60_000;
const RESTART_BACKOFF_INITIAL_MS = 500;
const RESTART_BACKOFF_CAP_MS = 30_000;
const HEALTHY_UPTIME_MS = 60_000;
const SHUTDOWN_RPC_TIMEOUT_MS = 1_500;

interface VoiceSession {
  realtimeSessionId: string;
  active: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
}

export async function runServer(
  config: ServerConfig,
  version: string,
): Promise<void> {
  const stateDir = stateDirectory(process.env, homedir());
  const appServerCwd = join(stateDir, "app-server");
  mkdirSync(appServerCwd, { recursive: true, mode: 0o700 });
  mkdirSync(config.workspace, { recursive: true, mode: 0o700 });

  const debugLog = config.debug
    ? (line: string) =>
        console.error(`[debug] ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)
    : undefined;

  let appServer: AppServer | null = null;
  let threadId: string | null = null;
  let threadReady = false;
  let client: ServerWebSocket<undefined> | null = null;
  let session: VoiceSession | null = null;
  // Sessions we abandoned (superseded, timed out, or client gone) whose
  // closed/error notification is still in flight; those events must not be
  // attributed to the current session.
  let pendingPredecessorClose = 0;
  let restartFailures = 0;
  let shuttingDown = false;

  function send(payload: Record<string, unknown>): void {
    if (client && client.readyState === 1) client.send(JSON.stringify(payload));
  }

  function sendReady(): void {
    if (!client || !threadReady || !threadId) return;
    send({
      type: "ready",
      protocol: PROTOCOL_VERSION,
      threadId,
      workspace: config.workspace,
      model: config.model ?? null,
      effort: config.effort ?? null,
      voiceModel: config.voiceModel ?? null,
      voice: config.voice ?? null,
    });
  }

  function clearSession(): void {
    if (session?.startTimer) clearTimeout(session.startTimer);
    session = null;
  }

  /** Abandon the current session: its late events belong to a predecessor now. */
  function abandonSession(): void {
    if (!session) return;
    pendingPredecessorClose++;
    clearSession();
    if (appServer && threadId) {
      void appServer.request("thread/realtime/stop", { threadId }).catch(() => {});
    }
  }

  function threadOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {
      cwd: config.workspace,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
    };
    if (config.model) options["model"] = config.model;
    if (config.effort) {
      options["config"] = { model_reasoning_effort: config.effort };
    }
    return options;
  }

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
            ...threadOptions(),
          }),
        );
      } catch (error) {
        console.error(
          `thread/resume failed (${error instanceof Error ? error.message : String(error)}); starting a fresh thread`,
        );
      }
    }
    return extractThreadId(await server.request("thread/start", threadOptions()));
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
    const hadSession = session !== null;
    clearSession();
    pendingPredecessorClose = 0; // every session died with the child
    if (shuttingDown || expected) return;
    if (hadSession) send({ type: "closed", reason: "app-server-exited" });
    if (Date.now() - server.spawnedAt > HEALTHY_UPTIME_MS) restartFailures = 0;
    const delay = Math.min(
      RESTART_BACKOFF_INITIAL_MS * 2 ** restartFailures,
      RESTART_BACKOFF_CAP_MS,
    );
    console.error(
      `app-server exited unexpectedly (code ${code}); restarting in ${delay}ms`,
    );
    setTimeout(() => void restart(), delay);
  }

  async function restart(): Promise<void> {
    if (shuttingDown) return;
    try {
      await connectAppServer();
      restartFailures = 0;
      console.error("app-server restarted; orchestrator thread re-established");
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

  function handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (!method.startsWith("thread/realtime/")) return;
    if (params["threadId"] !== undefined && params["threadId"] !== threadId) return;
    switch (method) {
      case "thread/realtime/started": {
        const sessionId = params["realtimeSessionId"];
        if (session && sessionId === session.realtimeSessionId) {
          session.active = true;
          if (session.startTimer) {
            clearTimeout(session.startTimer);
            session.startTimer = null;
          }
          debugLog?.(`realtime session ${String(sessionId)} active`);
        } else if (!session) {
          // An abandoned start came up after all; reclaim the orphan. Its
          // closed notification is already budgeted in pendingPredecessorClose.
          debugLog?.("stopping orphaned realtime session");
          if (appServer && threadId) {
            void appServer
              .request("thread/realtime/stop", { threadId })
              .catch(() => {});
          }
        }
        // A foreign id while a session exists: a predecessor coming up late;
        // its stop is already in flight. Never apply it to the current session.
        return;
      }
      case "thread/realtime/sdp": {
        const sdp = params["sdp"];
        // `started` always precedes the answer within a session, so an answer
        // with no active session belongs to an abandoned predecessor: drop it
        // rather than poison the successor's peer.
        if (session?.active && typeof sdp === "string") {
          send({ type: "answer", sdp });
        } else {
          debugLog?.("dropping realtime sdp with no active session");
        }
        return;
      }
      case "thread/realtime/error":
      case "thread/realtime/closed": {
        if (pendingPredecessorClose > 0) {
          pendingPredecessorClose--;
          debugLog?.(`${method} attributed to an abandoned session`);
          return;
        }
        if (!session) return;
        clearSession();
        if (method === "thread/realtime/error") {
          const message =
            typeof params["message"] === "string"
              ? params["message"]
              : "realtime session failed";
          send({ type: "error", code: "realtime-failed", message, fatal: true });
        } else {
          send({
            type: "closed",
            ...(typeof params["reason"] === "string"
              ? { reason: params["reason"] }
              : {}),
          });
        }
        sendReady(); // the thread survives its voice session; offers reopen
        return;
      }
      default:
        return; // transcript deltas and other realtime chatter: not our surface
    }
  }

  async function handleOffer(sdp: string): Promise<void> {
    if (!threadReady || !appServer || !threadId) {
      send({
        type: "error",
        code: "not-ready",
        message: "no orchestrator thread yet; wait for ready",
        fatal: false,
      });
      return;
    }
    abandonSession(); // renewal or retry: supersede whatever is running
    const realtimeSessionId = crypto.randomUUID();
    const next: VoiceSession = { realtimeSessionId, active: false, startTimer: null };
    session = next;
    next.startTimer = setTimeout(() => {
      if (session !== next || next.active) return;
      abandonSession(); // it may still come up; budget its late events
      send({
        type: "error",
        code: "realtime-failed",
        message: `realtime session did not start within ${REALTIME_START_TIMEOUT_MS}ms`,
        fatal: true,
      });
      sendReady();
    }, REALTIME_START_TIMEOUT_MS);

    const params: Record<string, unknown> = {
      threadId,
      realtimeSessionId,
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp },
    };
    if (config.voiceModel) params["model"] = config.voiceModel;
    if (config.voice) params["voice"] = config.voice;

    try {
      // The response is only a queue-ack; readiness arrives as a notification.
      await appServer.request("thread/realtime/start", params);
    } catch (error) {
      if (session !== next) return; // superseded while in flight
      if (error instanceof AppServerError && error.timedOut) {
        abandonSession(); // the ack timed out but the session may still come up
      } else {
        clearSession(); // synchronous rejection: the session never existed
      }
      send({
        type: "error",
        code: "realtime-failed",
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
      sendReady();
    }
  }

  function handleClientMessage(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      send({
        type: "error",
        code: "bad-message",
        message: "messages must be JSON",
        fatal: false,
      });
      return;
    }
    const type = (message as Record<string, unknown> | null)?.["type"];
    if (type === "offer") {
      const sdp = (message as Record<string, unknown>)["sdp"];
      if (typeof sdp !== "string" || sdp.length === 0) {
        send({
          type: "error",
          code: "bad-offer",
          message: "offer requires a non-empty sdp string",
          fatal: false,
        });
        return;
      }
      void handleOffer(sdp);
      return;
    }
    send({
      type: "error",
      code: "unknown-message",
      message: `unsupported message type ${JSON.stringify(type ?? null)}`,
      fatal: false,
    });
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
        abandonSession(); // session lifetime is socket lifetime
      },
    },
  });

  const orDefault = (value: string | undefined) => value ?? "(codex default)";
  console.log(`agentvoicenext server listening on ws://127.0.0.1:${config.port}/ws`);
  console.log(`  workspace       ${config.workspace}`);
  console.log(`  thread          ${threadId}`);
  console.log(`  model           ${orDefault(config.model)}  effort ${orDefault(config.effort)}`);
  console.log(`  voice model     ${orDefault(config.voiceModel)}  voice ${config.voice ?? "(upstream default)"}`);
  console.log(`  sandbox         ${config.sandbox}  approvals ${config.approvalPolicy}`);

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("shutting down");
    try {
      client?.close(1001, "server shutting down");
    } catch {
      // client may already be gone
    }
    if (session && appServer && threadId) {
      clearSession();
      await appServer
        .request("thread/realtime/stop", { threadId }, SHUTDOWN_RPC_TIMEOUT_MS)
        .catch(() => {});
    }
    httpServer.stop(true);
    if (appServer) await appServer.stop().catch(() => {});
  }

  await new Promise<void>((resolve) => {
    const onSignal = () => void shutdown().then(resolve);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
