import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";

const START_TIMEOUT_MS = 30_000;
const LOG_LIMIT_BYTES = 1024 * 1024;

// LiveKit allows AgentSession.close() 60 seconds before job shutdown
// callbacks run. Each surrounding timeout must therefore be strictly larger.
export const LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS = 75_000;
export const LIVEKIT_WORKER_CONTROL_TIMEOUT_MS = 90_000;
export const LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS = 10_000;
export const LIVEKIT_NUM_IDLE_PROCESSES = 1;

export interface LiveKitConnection {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function createLocalLiveKitCredentials(): Pick<LiveKitConnection, "apiKey" | "apiSecret"> {
  return {
    apiKey: `AV${randomBytes(12).toString("hex")}`,
    apiSecret: randomBytes(32).toString("base64url"),
  };
}

export class LocalLiveKitServer {
  readonly connection: LiveKitConnection;
  readonly version: string;
  readonly fatal: Promise<never>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<ProcessExit>,
    private readonly output: BoundedOutput,
    connection: LiveKitConnection,
    version: string,
  ) {
    this.connection = connection;
    this.version = version;
    this.fatal = exit.then(({ code, signal }) => {
      throw new Error(
        `local LiveKit server exited (code ${code}, signal ${signal ?? "none"})\n${output.text()}`,
      );
    });
    void this.fatal.catch(() => {});
  }

  static async start(liveKitServerPath = "livekit-server"): Promise<LocalLiveKitServer> {
    const environment = environmentWithoutOpenAiApiKey();
    const [signalPort, rtcTcpPort, udpPort, version] = await Promise.all([
      freeTcpPort(),
      freeTcpPort(),
      freeUdpPort(),
      commandVersion(liveKitServerPath, environment),
    ]);
    const connection = {
      url: `ws://127.0.0.1:${signalPort}`,
      ...createLocalLiveKitCredentials(),
    };
    environment["LIVEKIT_KEYS"] = `${connection.apiKey}: ${connection.apiSecret}\n`;
    const child = spawn(
      liveKitServerPath,
      [
        "--dev",
        "--bind",
        "127.0.0.1",
        "--node-ip",
        "127.0.0.1",
        "--port",
        String(signalPort),
        "--rtc.tcp_port",
        String(rtcTcpPort),
        "--udp-port",
        String(udpPort),
        "--logging.level",
        "warn",
      ],
      {
        env: environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = captureOutput(child);
    const exit = processExit(child);
    const server = new LocalLiveKitServer(child, exit, output, connection, version);
    try {
      await Promise.race([
        waitForHttp(`http://127.0.0.1:${signalPort}/`, (status) => status < 500),
        server.fatal,
      ]);
      return server;
    } catch (error) {
      await server.stop().catch(() => {});
      throw error;
    }
  }

  logs(): string {
    return this.output.text();
  }

  async stop(): Promise<void> {
    await stopManagedProcess(this.child, this.exit);
  }
}

export class LiveKitAgentWorker {
  readonly fatal: Promise<never>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<ProcessExit>,
    private readonly output: BoundedOutput,
    private readonly controlToken: string,
  ) {
    this.fatal = exit.then(({ code, signal }) => {
      throw new Error(
        `LiveKit agent worker exited (code ${code}, signal ${signal ?? "none"})\n${output.text()}`,
      );
    });
    void this.fatal.catch(() => {});
  }

  static async start(options: {
    connection: LiveKitConnection;
    agentName: string;
    openAiApiKey?: string;
    telemetrySocketPath?: string;
    telemetryRunId?: string;
    expectedWorkspace?: string;
    agentPath?: string;
    workerPath?: string;
    runtimePath?: string;
    fxPath?: string;
    fxTerminalLogPath?: string;
    fxStderrLogPath?: string;
    shutdownProbePath?: string;
  }): Promise<LiveKitAgentWorker> {
    const workerPort = await freeTcpPort();
    const controlToken = randomBytes(32).toString("hex");
    const environment = environmentWithoutOpenAiApiKey();
    for (const name of Object.keys(environment)) {
      if (
        name.startsWith("LIVEKIT_") ||
        name.startsWith("AGENTVOICE_EXPECTED_") ||
        name.startsWith("AGENTVOICE_TELEMETRY_") ||
        name.startsWith("AGENTVOICE_WORKER_") ||
        name.startsWith("AGENTVOICE_FX_") ||
        name.startsWith("AGENTVOICE_SHUTDOWN_PROBE_")
      ) {
        delete environment[name];
      }
    }
    if (options.openAiApiKey) environment["OPENAI_API_KEY"] = options.openAiApiKey;
    environment["LIVEKIT_URL"] = options.connection.url;
    environment["LIVEKIT_API_KEY"] = options.connection.apiKey;
    environment["LIVEKIT_API_SECRET"] = options.connection.apiSecret;
    if (options.telemetrySocketPath) {
      environment["AGENTVOICE_TELEMETRY_SOCKET_PATH"] = options.telemetrySocketPath;
    }
    if (options.telemetryRunId) {
      environment["AGENTVOICE_TELEMETRY_RUN_ID"] = options.telemetryRunId;
    }
    if (options.expectedWorkspace) {
      environment["AGENTVOICE_EXPECTED_WORKSPACE"] = resolve(options.expectedWorkspace);
    }
    environment["AGENTVOICE_WORKER_AGENT_PATH"] = resolve(
      options.agentPath ?? "src/livekit-agent.ts",
    );
    environment["AGENTVOICE_WORKER_AGENT_NAME"] = options.agentName;
    environment["AGENTVOICE_WORKER_CONTROL_TOKEN"] = controlToken;
    environment["AGENTVOICE_WORKER_HTTP_PORT"] = String(workerPort);
    if (options.fxPath) environment["AGENTVOICE_FX_PATH"] = options.fxPath;
    if (options.fxTerminalLogPath) {
      environment["AGENTVOICE_FX_TERMINAL_LOG_PATH"] = options.fxTerminalLogPath;
    }
    if (options.fxStderrLogPath) {
      environment["AGENTVOICE_FX_STDERR_LOG_PATH"] = options.fxStderrLogPath;
    }
    if (options.shutdownProbePath) {
      environment["AGENTVOICE_SHUTDOWN_PROBE_PATH"] = options.shutdownProbePath;
    }
    const runtimePath = options.runtimePath ?? "bun";
    const workerPath = resolve(options.workerPath ?? "src/livekit-worker.ts");
    const child = spawn(runtimePath, [workerPath], {
      cwd: process.cwd(),
      env: environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = captureOutput(child);
    const exit = processExit(child);
    const worker = new LiveKitAgentWorker(child, exit, output, controlToken);
    try {
      await Promise.race([
        waitForHttp(`http://127.0.0.1:${workerPort}/`, (status) => status === 200),
        worker.fatal,
      ]);
      return worker;
    } catch (error) {
      await worker.stop().catch(() => {});
      throw error;
    }
  }

  logs(): string {
    return this.output.text();
  }

  async stop(options: { controlTimeoutMs?: number } = {}): Promise<void> {
    await stopControlledWorker(
      this.child,
      this.exit,
      this.controlToken,
      options.controlTimeoutMs ?? LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
    );
  }
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class BoundedOutput {
  private value = "";
  private truncated = false;

  append(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    const next = this.value + text;
    if (Buffer.byteLength(next) <= LOG_LIMIT_BYTES) {
      this.value = next;
      return;
    }
    this.truncated = true;
    this.value = next.slice(-LOG_LIMIT_BYTES);
  }

  text(): string {
    return this.truncated ? `[earlier output truncated]\n${this.value}` : this.value;
  }
}

function captureOutput(child: ChildProcessWithoutNullStreams): BoundedOutput {
  const output = new BoundedOutput();
  child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk));
  return output;
}

function processExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function stopManagedProcess(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
  timeouts: {
    interruptTimeoutMs: number;
    terminateTimeoutMs: number;
    killTimeoutMs: number;
    signalScope?: "group" | "process";
  } = {
    interruptTimeoutMs: 3_000,
    terminateTimeoutMs: 3_000,
    killTimeoutMs: 2_000,
  },
): Promise<void> {
  const pid = child.pid;
  if (!pid || (await settlesWithin(exit, 100))) {
    return;
  }
  if (timeouts.signalScope === "process") {
    signalProcess(pid, "SIGINT");
    if (!(await settlesWithin(exit, timeouts.interruptTimeoutMs))) {
      signalProcess(pid, "SIGTERM");
    }
    if (!(await settlesWithin(exit, timeouts.terminateTimeoutMs))) {
      signalProcess(pid, "SIGKILL");
    }
    if (!(await settlesWithin(exit, timeouts.killTimeoutMs))) {
      throw new Error(`managed process ${pid} survived SIGKILL`);
    }
    if (!(await processGroupSettlesWithin(pid, timeouts.killTimeoutMs))) {
      throw new Error(`managed worker process group ${pid} survived its leader`);
    }
    return;
  }
  if (!(await processGroupExists(pid))) return;
  signalProcessGroup(pid, "SIGINT");
  if (!(await processGroupSettlesWithin(pid, timeouts.interruptTimeoutMs))) {
    signalProcessGroup(pid, "SIGTERM");
  }
  if (!(await processGroupSettlesWithin(pid, timeouts.terminateTimeoutMs))) {
    signalProcessGroup(pid, "SIGKILL");
  }
  if (!(await processGroupSettlesWithin(pid, timeouts.killTimeoutMs))) {
    throw new Error(`managed process group ${pid} survived SIGKILL`);
  }
  await settlesWithin(exit, timeouts.killTimeoutMs);
}

async function stopControlledWorker(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
  controlToken: string,
  controlTimeoutMs: number,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (!(await settlesWithin(exit, 100))) {
    try {
      child.stdin.end(`${controlToken}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
    }
    if (!(await settlesWithin(exit, controlTimeoutMs))) {
      signalProcess(pid, "SIGTERM");
    }
    if (!(await settlesWithin(exit, 5_000))) {
      signalProcess(pid, "SIGKILL");
    }
    if (!(await settlesWithin(exit, 3_000))) {
      throw new Error(`controlled worker process ${pid} survived SIGKILL`);
    }
  }

  if (!(await processGroupSettlesWithin(pid, 3_000))) {
    signalProcessGroup(pid, "SIGKILL");
  }
  if (!(await processGroupSettlesWithin(pid, 3_000))) {
    throw new Error(`controlled worker process group ${pid} survived shutdown`);
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function processGroupExists(pid: number): Promise<boolean> {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function processGroupSettlesWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!(await processGroupExists(pid))) return true;
    await Bun.sleep(25);
  }
  return !(await processGroupExists(pid));
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
}

async function waitForHttp(
  url: string,
  accept: (status: number) => boolean,
  timeoutMs = START_TIMEOUT_MS,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError = "no response";
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (accept(response.status)) return;
      lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(`service at ${url} was not ready within ${timeoutMs}ms: ${lastError}`);
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolvePromise(address.port));
    });
  });
}

async function commandVersion(
  command: string,
  environment = environmentWithoutOpenAiApiKey(),
): Promise<string> {
  const child = spawn(command, ["--version"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const { code, signal } = await processExit(child);
  if (code !== 0) {
    throw new Error(
      `${command} --version failed (code ${code}, signal ${signal ?? "none"}): ` +
        Buffer.concat(stderr).toString("utf8").trim(),
    );
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}
