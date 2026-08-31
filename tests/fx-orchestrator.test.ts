import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FxAdeEvent,
  FxAdeServer,
  FxHeadlessOrchestrator,
  FxLifecycle,
  FxWorkControlClient,
  FxWorkControlError,
  fxEnvironment,
} from "../src/fx-orchestrator.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Fx headless lifecycle", () => {
  test("scrubs voice-worker authority from the Fx subprocess environment", () => {
    const environment = fxEnvironment(
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        instanceId: "instance-1",
      },
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "synthetic-openai-key",
        LIVEKIT_API_SECRET: "synthetic-livekit-secret",
        AGENTVOICE_WORKER_CONTROL_TOKEN: "synthetic-control-token",
        AGENTVOICE_TELEMETRY_SOCKET_PATH: "/tmp/telemetry.sock",
        HERDR_SESSION: "synthetic-session",
        FX_CODEX_CREDENTIAL_FD: "9",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      FX_AUTO_UPGRADE: "0",
      FX_MODEL: "gpt-5.6-terra",
      FX_EFFORT: "medium",
      FX_ADE_INSTANCE_ID: "instance-1",
      FX_WORK_CONTROL_INSTANCE_ID: "instance-1",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("LIVEKIT_API_SECRET");
    expect(environment).not.toHaveProperty("AGENTVOICE_WORKER_CONTROL_TOKEN");
    expect(environment).not.toHaveProperty("AGENTVOICE_TELEMETRY_SOCKET_PATH");
    expect(environment).not.toHaveProperty("HERDR_SESSION");
    expect(environment).not.toHaveProperty("FX_CODEX_CREDENTIAL_FD");
  });

  test("rolls back the detached process group and temporary sockets after startup failure", async () => {
    const directory = temporaryDirectory();
    const fakeFxPath = join(directory, "fake-fx");
    const pidPath = join(directory, "fake-fx.pid");
    writeFileSync(fakeFxPath, fakeFxProgram(pidPath), { mode: 0o700 });
    chmodSync(fakeFxPath, 0o700);
    const orchestrator = new FxHeadlessOrchestrator({
      workspace: directory,
      fxPath: fakeFxPath,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    const resourceDirectory = (orchestrator as unknown as { tempDirectory: string }).tempDirectory;
    let spawnedPid: number | null = null;

    try {
      await expect(orchestrator.start()).rejects.toThrow();
      spawnedPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(spawnedPid) && spawnedPid > 0).toBe(true);
      expect(processExists(spawnedPid)).toBe(false);
      expect(existsSync(resourceDirectory)).toBe(false);
    } finally {
      await orchestrator.stop().catch(() => {});
      if (spawnedPid && processExists(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
    }
  });

  test("rejects the fatal monitor when Fx exits after becoming ready", async () => {
    const directory = temporaryDirectory();
    const fakeFxPath = join(directory, "ready-fx");
    const pidPath = join(directory, "ready-fx.pid");
    writeFileSync(fakeFxPath, readyFxProgram(pidPath), { mode: 0o700 });
    chmodSync(fakeFxPath, 0o700);
    const orchestrator = new FxHeadlessOrchestrator({
      workspace: directory,
      fxPath: fakeFxPath,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    let spawnedPid: number | null = null;

    try {
      await orchestrator.start();
      spawnedPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(spawnedPid) && spawnedPid > 0).toBe(true);
      process.kill(spawnedPid, "SIGTERM");
      await expect(orchestrator.fatal).rejects.toThrow("Fx exited during the active session");
    } finally {
      await orchestrator.stop().catch(() => {});
      if (spawnedPid && processExists(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
    }
  });

  test("exposes Fx descriptor 3 as one paused, opaque broker channel", async () => {
    const directory = temporaryDirectory();
    const fakeFxPath = join(directory, "broker-fx");
    const pidPath = join(directory, "broker-fx.pid");
    writeFileSync(fakeFxPath, readyFxProgram(pidPath), { mode: 0o700 });
    chmodSync(fakeFxPath, 0o700);
    const orchestrator = new FxHeadlessOrchestrator({
      workspace: directory,
      fxPath: fakeFxPath,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });

    try {
      expect(() => orchestrator.acquireCredentialBrokerChannel()).toThrow("before Fx startup");
      await orchestrator.start();
      const channel = orchestrator.acquireCredentialBrokerChannel();
      expect(channel.isPaused()).toBe(true);
      expect(() => orchestrator.acquireCredentialBrokerChannel()).toThrow("already acquired");
      const bytes = await new Promise<Buffer>((resolvePromise, reject) => {
        channel.once("data", (chunk: Buffer) => resolvePromise(chunk));
        channel.once("error", reject);
        channel.resume();
      });
      expect(bytes.toString("utf8")).toBe("opaque-broker-bytes");
      channel.destroy();
    } finally {
      await orchestrator.stop().catch(() => {});
    }
  });
});

describe("Fx work control", () => {
  test("authenticates, frames, and validates a semantic steering admission", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "work.sock");
    const server = await fakeControlServer(socketPath, (request) => {
      expect(request["schema"]).toBe(1);
      expect(request["instance_id"]).toBe("instance-1");
      expect(request["token"]).toBe("secret-token");
      expect(request["method"]).toBe("work.steer");
      expect(request["params"]).toEqual({ text: "Keep the exact replay idempotent." });
      return {
        schema: 1,
        request_id: request["request_id"],
        instance_id: "instance-1",
        ok: true,
        result: {
          turn_id: "52",
          disposition: "steering",
          snapshot: {
            active_turn_id: "41",
            queue_paused: false,
            queue: [
              {
                turn_id: "52",
                kind: "steering",
                text: "Keep the exact replay idempotent.",
                has_images: false,
                has_skill_bindings: false,
                has_review_draft: false,
              },
            ],
          },
        },
      };
    });
    const client = new FxWorkControlClient({
      socketPath,
      instanceId: "instance-1",
      token: "secret-token",
    });

    await expect(client.admit("Keep the exact replay idempotent.")).resolves.toEqual({
      delegationTurnId: "52",
      disposition: "steering",
      activeTurnId: "41",
      snapshot: {
        active_turn_id: "41",
        queue_paused: false,
        queue: [
          {
            turn_id: "52",
            kind: "steering",
            text: "Keep the exact replay idempotent.",
            has_images: false,
            has_skill_bindings: false,
            has_review_draft: false,
          },
        ],
      },
    });
    await closeServer(server);
  });

  test("surfaces a correlated Fx application error", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "work.sock");
    const server = await fakeControlServer(socketPath, (request) => ({
      schema: 1,
      request_id: request["request_id"],
      instance_id: "instance-1",
      ok: false,
      error: { code: "worker_stopped", message: "the Fx worker has stopped" },
    }));
    const client = new FxWorkControlClient({
      socketPath,
      instanceId: "instance-1",
      token: "secret-token",
    });

    await expect(client.snapshot()).rejects.toEqual(
      new FxWorkControlError("worker_stopped", "the Fx worker has stopped"),
    );
    await closeServer(server);
  });
});

describe("Fx ADE lifecycle", () => {
  test("accepts newline-framed events and returns the last Stop at PostTurnEnd", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "ade.sock");
    const lifecycle = new FxLifecycle("instance-1");
    const observed: string[] = [];
    const server = new FxAdeServer({
      socketPath,
      lifecycle,
      onEvent: (event) => observed.push(event.event),
    });
    await server.start();
    const started = lifecycle.waitForStarted(1_000);
    const completed = lifecycle.waitForTurn("41", 1_000);

    await sendAde(socketPath, adeEvent(1, "FxStarted", null, {}));
    await sendAde(socketPath, adeEvent(2, "TurnStarted", 41, {}));
    await sendAde(
      socketPath,
      adeEvent(3, "Stop", 41, {
        assistant_text: "First candidate.",
        provider_disposition: "completed",
        can_continue: true,
      }),
    );
    await sendAde(
      socketPath,
      adeEvent(4, "Stop", 41, {
        assistant_text: "Implemented and verified the replay behavior.",
        provider_disposition: "completed",
        can_continue: true,
      }),
    );
    await sendAde(
      socketPath,
      adeEvent(5, "PostTurnEnd", 41, {
        outcome: "completed",
        provider_disposition: "completed",
      }),
    );

    expect((await started).event).toBe("FxStarted");
    expect(await completed).toMatchObject({
      turnId: "41",
      outcome: "completed",
      providerDisposition: "completed",
      assistantText: "Implemented and verified the replay behavior.",
    });
    expect(observed).toEqual(["FxStarted", "TurnStarted", "Stop", "Stop", "PostTurnEnd"]);
    await server.close();
  });

  test("rejects events attributed to another instance", () => {
    const lifecycle = new FxLifecycle("instance-1");
    expect(() =>
      lifecycle.ingest({ ...adeEvent(1, "FxStarted", null, {}), instance_id: "instance-2" }),
    ).toThrow("another Fx instance");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-fx-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeControlServer(
  socketPath: string,
  respond: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<Server> {
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (bytes.length < length + 4) return;
      const request = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
      const response = Buffer.from(JSON.stringify(respond(request)));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(response.length);
      socket.end(Buffer.concat([header, response]));
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function sendAde(socketPath: string, event: FxAdeEvent): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.once("error", reject);
    socket.once("close", () => resolvePromise());
    socket.once("connect", () => socket.end(`${JSON.stringify(event)}\n`));
  });
}

function adeEvent(
  sequence: number,
  event: string,
  turnId: number | null,
  payload: Record<string, unknown>,
): FxAdeEvent {
  return {
    schema_version: 1,
    sequence,
    event,
    instance_id: "instance-1",
    context: {
      agent_role: "main",
      workspace_root: "/workspace",
      session_id: "session-1",
      parent_session_id: null,
      subagent_id: null,
      turn_id: turnId,
      agent_state: event === "PostTurnEnd" ? "idle" : event === "FxStarted" ? "idle" : "working",
      attention_kind: null,
    },
    payload,
  };
}

function fakeFxProgram(pidPath: string): string {
  return `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const argument = process.argv[2];
if (argument === "status") {
  console.log(JSON.stringify({
    kind: "status",
    model_source: "Codex subscription",
    build_revision: "test-revision",
    auth: "Codex subscription",
    connected_providers: ["codex"],
    permission_mode: "yolo",
  }));
  process.exit(0);
}
if (argument === "--version") {
  console.log("0.0.7");
  process.exit(0);
}
if (argument === "--fxnk-version") {
  console.log("fxnk 0.5.0 (fx 0.0.7)");
  process.exit(0);
}

writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const event = {
  schema_version: 1,
  sequence: 1,
  event: "FxStarted",
  instance_id: process.env.FX_ADE_INSTANCE_ID,
  context: {
    agent_role: "main",
    workspace_root: process.cwd(),
    session_id: "test-session",
    parent_session_id: null,
    subagent_id: null,
    turn_id: null,
    agent_state: "idle",
    attention_kind: null,
  },
  payload: {},
};
await new Promise((resolve, reject) => {
  const socket = createConnection({ path: process.env.FX_ADE_SOCKET_PATH });
  socket.once("error", reject);
  socket.once("close", resolve);
  socket.once("connect", () => socket.end(JSON.stringify(event) + "\\n"));
});
process.exit(12);
`;
}

function readyFxProgram(pidPath: string): string {
  return `#!/usr/bin/env bun
import { writeFileSync, writeSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const argument = process.argv[2];
if (argument === "status") {
  console.log(JSON.stringify({
    kind: "status",
    model_source: "Codex subscription",
    build_revision: "test-revision",
    auth: "Codex subscription",
    connected_providers: ["codex"],
    permission_mode: "yolo",
  }));
  process.exit(0);
}
if (argument === "--version") {
  console.log("0.0.7");
  process.exit(0);
}
if (argument === "--fxnk-version") {
  console.log("fxnk 0.5.0 (fx 0.0.7)");
  process.exit(0);
}

writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
if (process.env.FX_CODEX_CREDENTIAL_FD !== "3") process.exit(13);
writeSync(3, "opaque-broker-bytes");
const server = createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) return;
    const length = bytes.readUInt32BE(0);
    if (bytes.length < length + 4) return;
    const request = JSON.parse(bytes.subarray(4, length + 4).toString("utf8"));
    const response = Buffer.from(JSON.stringify({
      schema: 1,
      request_id: request.request_id,
      instance_id: process.env.FX_WORK_CONTROL_INSTANCE_ID,
      ok: true,
      result: {
        snapshot: { active_turn_id: null, queue_paused: false, queue: [] },
      },
    }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(response.length);
    socket.end(Buffer.concat([header, response]));
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(process.env.FX_WORK_CONTROL_SOCKET_PATH, resolve);
});
const event = {
  schema_version: 1,
  sequence: 1,
  event: "FxStarted",
  instance_id: process.env.FX_ADE_INSTANCE_ID,
  context: {
    agent_role: "main",
    workspace_root: process.cwd(),
    session_id: "test-session",
    parent_session_id: null,
    subagent_id: null,
    turn_id: null,
    agent_state: "idle",
    attention_kind: null,
  },
  payload: {},
};
await new Promise((resolve, reject) => {
  const socket = createConnection({ path: process.env.FX_ADE_SOCKET_PATH });
  socket.once("error", reject);
  socket.once("close", resolve);
  socket.once("connect", () => socket.end(JSON.stringify(event) + "\\n"));
});
await new Promise(() => {});
`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
