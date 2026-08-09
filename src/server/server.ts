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
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { stateDirectory, tokenPath } from "../paths.ts";
import {
  CLOSE_BUSY,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "../protocol.ts";
import {
  accountsDirectory,
  balancerCliPresent,
  discoverProfiles,
  listPoolAccounts,
  maxUsedPercent,
  onboardingFailureMessage,
  reconcileFarm,
  runBalancerCommand,
  selectAccount,
} from "./accounts.ts";
import { AppServer, AppServerError } from "./appserver.ts";
import { PROMPT_FILES, promptFilenames, readPrompts, type ServerConfig } from "./config.ts";
import { gateRequest, tokenMatches } from "./gate.ts";
import { realtimeParams, threadParams, workerThreadParams } from "./params.ts";
import { VoiceSessionManager } from "./session.ts";
import { WorkerManager } from "./workers.ts";

type ClientSocket = ServerWebSocket<{ authorized: boolean }>;

const RESTART_BACKOFF_INITIAL_MS = 500;
const RESTART_BACKOFF_CAP_MS = 30_000;
const HEALTHY_UPTIME_MS = 60_000;
const SHUTDOWN_STOP_TIMEOUT_MS = 1_500;

/**
 * Persisted rather than per-run so the client can outlive server restarts and
 * a remote client only ever copies it once. 0600 makes file permissions the
 * boundary between local users.
 */
function loadOrCreateToken(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // fall through to create
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function runServer(config: ServerConfig, version: string): Promise<void> {
  const stateDir = stateDirectory(process.env, homedir());
  const appServerCwd = join(stateDir, "app-server");
  mkdirSync(appServerCwd, { recursive: true, mode: 0o700 });
  mkdirSync(config.orchestrator.workspace, { recursive: true, mode: 0o700 });
  const tokenFile = tokenPath(process.env, homedir());
  const token = loadOrCreateToken(tokenFile);

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
  let client: ClientSocket | null = null;
  let restartFailures = 0;
  let shuttingDown = false;

  // Account balancing state. The active account is fixed per child; rotation
  // is a supervised restart at an idle boundary onto the balancer's next pick.
  const canonicalHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const accountsDir = accountsDirectory(process.env, homedir());
  let activeAccount: string | null = null; // email, or null for the canonical home
  let orchestratorTurnActive = false;
  let exhaustedPercent: number | null = null;
  let rotating = false;

  interface SpawnChoice {
    codexHome?: string;
    account: string | null;
  }

  async function chooseSpawnHome(): Promise<SpawnChoice> {
    if (!config.accounts.balance) return { account: null };
    const selection = await selectAccount(discoverProfiles(accountsDir), runBalancerCommand);
    if (selection.kind === "canonical") {
      console.error(`accounts: canonical home fallback — ${selection.reason}`);
      return { account: null };
    }
    reconcileFarm(canonicalHome, selection.profile.directory, (message) =>
      console.error(`accounts: ${message}`),
    );
    console.error(
      `accounts: selected ${selection.email} (${selection.profile.slug}) — ${selection.reason}`,
    );
    return { codexHome: selection.profile.directory, account: selection.email };
  }

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

  // Present only under orchestrator.dispatch; every effect requires a live
  // child and the orchestrator thread, and rejections surface to the model as
  // tool refusals rather than hangs (workers.ts owns that translation).
  const workers = config.orchestrator.dispatch
    ? new WorkerManager(
        {
          async startWorker(brief) {
            if (!appServer) throw new AppServerError("app-server is not running");
            const workerThreadId = extractThreadId(
              await appServer.request("thread/start", workerThreadParams(config)),
            );
            const turn = (await appServer.request("turn/start", {
              threadId: workerThreadId,
              input: [{ type: "text", text: brief }],
            })) as { turn?: { id?: string } };
            const turnId = turn?.turn?.id;
            if (!turnId) throw new AppServerError("app-server returned no turn id for the worker");
            return { threadId: workerThreadId, turnId };
          },
          async interruptWorker(workerThreadId, turnId) {
            if (!appServer) throw new AppServerError("app-server is not running");
            await appServer.request("turn/interrupt", { threadId: workerThreadId, turnId });
          },
          reportToOrchestrator(text) {
            if (!appServer || !threadId) return;
            // Fire and forget: upstream admission steers the report into a
            // running turn or opens a fresh one; a failure only loses one
            // report, and check_workers still carries the outcome.
            appServer
              .request("turn/start", {
                threadId,
                input: [{ type: "text", text }],
              })
              .catch((error) => {
                console.error(
                  `worker report failed to land: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          },
          onWorkerUpdate(worker) {
            send({ type: "worker", worker });
          },
          now: () => Date.now(),
          debug: debugLog,
        },
        config.orchestrator.dispatchReports === true,
      )
    : null;

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

  async function connectAppServer(preselected?: SpawnChoice): Promise<void> {
    const choice = preselected ?? (await chooseSpawnHome());
    const server = new AppServer({
      codexBin: config.codex,
      processCwd: appServerCwd,
      ...(choice.codexHome !== undefined ? { codexHome: choice.codexHome } : {}),
      clientVersion: version,
      onNotification: handleNotification,
      onRequest: handleAppServerRequest,
      onExit: (info) => handleAppServerExit(server, info),
      debug: debugLog,
    });
    activeAccount = choice.account;
    exhaustedPercent = null;
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
    orchestratorTurnActive = false;
    const hadSession = sessions.hasSession;
    sessions.reset(); // every session died with the child
    workers?.reset(); // running workers died with it too — marked lost, not resumed
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
    if (method === "turn/started" && params["threadId"] === threadId) {
      orchestratorTurnActive = true;
    } else if (method === "turn/completed" && params["threadId"] === threadId) {
      orchestratorTurnActive = false;
    } else if (method === "account/rateLimits/updated" && config.accounts.balance) {
      const used = maxUsedPercent(params);
      exhaustedPercent = used !== null && used >= config.accounts.switchThreshold ? used : null;
    }
    if (method === "turn/completed" && workers) {
      const turnThread = params["threadId"];
      if (typeof turnThread === "string" && workers.ownsThread(turnThread)) {
        workers.handleTurnCompleted(turnThread, (params["turn"] ?? {}) as Record<string, unknown>);
      }
      maybeRotate();
      return;
    }
    if (method.startsWith("thread/realtime/")) {
      if (params["threadId"] === undefined || params["threadId"] === threadId) {
        sessions.handleNotification(method, params);
      }
    }
    maybeRotate();
  }

  /**
   * An exhausted account rotates only between things: never under a voice
   * session, a running orchestrator turn, or live workers. The balancer is
   * consulted first — picking the already-active account disarms instead of
   * restarting into the same exhaustion.
   */
  function maybeRotate(): void {
    if (exhaustedPercent === null || rotating || shuttingDown) return;
    if (!config.accounts.balance || !appServer || !threadReady) return;
    if (sessions.hasSession || orchestratorTurnActive) return;
    if (workers?.snapshots().some((worker) => worker.status === "running")) return;
    rotating = true;
    const usedPercent = exhaustedPercent;
    void (async () => {
      try {
        const choice = await chooseSpawnHome();
        if (choice.account === null || choice.account === activeAccount) {
          exhaustedPercent = null; // nothing better; re-armed by the next update
          return;
        }
        const server = appServer;
        if (!server || sessions.hasSession || orchestratorTurnActive) return;
        console.error(
          `accounts: rotating off ${activeAccount ?? "canonical"} (${usedPercent}% used) to ${choice.account}`,
        );
        threadReady = false;
        await server.stop();
        await connectAppServer(choice);
        restartFailures = 0;
      } catch (error) {
        console.error(
          `accounts: rotation failed (${error instanceof Error ? error.message : String(error)}); restarting`,
        );
        setTimeout(() => void restart(), RESTART_BACKOFF_INITIAL_MS);
      } finally {
        rotating = false;
      }
    })();
  }

  function handleAppServerRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null {
    if (method !== "item/tool/call" || !workers) return null;
    // Only the orchestrator's thread carries the dispatch tools; anything
    // else falls through to the fail-closed denial.
    if (params["threadId"] !== threadId) return null;
    const tool = typeof params["tool"] === "string" ? params["tool"] : "";
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    return workers.handleToolCall(tool, args);
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

  // Balancing on + a balancing setup installed + nothing onboarded is a
  // configuration error, not a degraded mode: exit with the exact commands.
  // Without the CLIs the same config quietly runs canonical, so one config
  // deploys to every machine. Transient refusals later still fall back.
  if (config.accounts.balance && balancerCliPresent()) {
    const profiles = discoverProfiles(accountsDir);
    if (!profiles.some((profile) => profile.identity !== null)) {
      throw new Error(onboardingFailureMessage(await listPoolAccounts()));
    }
  }

  // Boot fails fast: the operator is present. Later child exits are supervised.
  await connectAppServer();

  const httpServer = Bun.serve<{ authorized: boolean }>({
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request, server) {
      const url = new URL(request.url);
      const verdict = gateRequest(
        request.headers.get("origin"),
        request.headers.get("host"),
        config.port,
      );
      if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });
      if (url.pathname === "/ws") {
        // A bad token still upgrades, then closes with 4401: a plain HTTP 401
        // reaches the client as an anonymous handshake failure, the close code
        // as a diagnosable error.
        const authorized = tokenMatches(url.searchParams.get("token"), token);
        return server.upgrade(request, { data: { authorized } })
          ? undefined
          : new Response("websocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/") {
        return Response.json({
          name: "agentvoice",
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
      open(ws: ClientSocket) {
        // Auth before busy: an unauthorized caller learns nothing about the slot.
        if (!ws.data.authorized) {
          ws.close(CLOSE_UNAUTHORIZED, "missing or wrong connection token");
          return;
        }
        if (client) {
          ws.close(CLOSE_BUSY, "another client is connected");
          return;
        }
        client = ws;
        debugLog?.("client connected");
        sendReady();
        // Replay worker state so a UI joining mid-run starts complete.
        for (const worker of workers?.snapshots() ?? []) send({ type: "worker", worker });
      },
      message(ws: ClientSocket, raw: string | Buffer) {
        if (ws !== client) return;
        handleClientMessage(typeof raw === "string" ? raw : raw.toString());
      },
      close(ws: ClientSocket) {
        if (ws !== client) return;
        client = null;
        debugLog?.("client disconnected");
        sessions.handleClientGone();
      },
    },
  });

  const orDefault = (value: string | undefined) => value ?? "(codex default)";
  const { orchestrator, voice } = config;
  console.log(`agentvoice server listening on ws://127.0.0.1:${config.port}/ws`);
  console.log(`  token           ${tokenFile}`);
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
  console.log(`  dispatch        ${orchestrator.dispatch === true ? "on" : "off"}`);
  console.log(
    `  accounts        ${
      config.accounts.balance
        ? `balancing (active: ${activeAccount ?? "canonical"}, rotate at ${config.accounts.switchThreshold}%)`
        : "canonical"
    }`,
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
