#!/usr/bin/env bun
/** Opt-in native boundary probe: disposable state, loopback only, no turns or media. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmFullAccess } from "../src/core/full-access.ts";

type Json = Record<string, unknown>;
const TIMEOUT_MS = 10_000;

class Client {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  readonly notifications: Json[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(String(data)) as Json;
      if (typeof frame["id"] === "number") {
        const pending = this.pending.get(frame["id"]);
        this.pending.delete(frame["id"]);
        if (frame["error"]) pending?.reject(new Error(JSON.stringify(frame["error"])));
        else pending?.resolve(frame["result"] as Json);
      } else this.notifications.push(frame);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Probe socket closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string, token: string, name: string): Promise<Client> {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const client = new Client(socket);
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("Probe connection failed")), {
            once: true,
          });
        }),
      );
      await client.request("initialize", {
        clientInfo: { name, version: "attachment-boundary-probe" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      return client;
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async request(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    try {
      return await bounded(
        new Promise<Json>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.socket.send(JSON.stringify({ id, method, params }));
        }),
      );
    } finally {
      this.pending.delete(id);
    }
  }

  async settings(threadId: string): Promise<Json> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const index = this.notifications.findIndex(
        (frame) =>
          frame["method"] === "thread/settings/updated" &&
          (frame["params"] as Json)["threadId"] === threadId,
      );
      if (index !== -1)
        return (this.notifications.splice(index, 1)[0]!["params"] as Json)[
          "threadSettings"
        ] as Json;
      await Bun.sleep(20);
    }
    throw new Error("No native settings notification");
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Probe timed out")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (process.platform !== "darwin") throw new Error("This probe requires macOS sandbox-exec.");
const codex = process.env["CODEX_PATH"];
if (!codex?.startsWith("/"))
  throw new Error("Set CODEX_PATH to an absolute stock Codex executable.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-attachment-probe-")));
try {
  await runProbe(root, codex);
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function runProbe(root: string, codex: string): Promise<void> {
  const nativeHome = join(root, "codex");
  const workspace = join(root, "workspace");
  mkdirSync(nativeHome);
  mkdirSync(workspace);
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const clients: Client[] = [];
  // No inherited provider keys, native login, user config, or external network access.
  const child = Bun.spawn(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      '(version 1) (allow default) (deny network*) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))',
      codex,
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenFile,
      "-c",
      'model="gpt-5.4"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    ],
    {
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, CODEX_HOME: nativeHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const listening = Promise.withResolvers<string>();
  let output = "";
  async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-16_384);
      const match = output.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/);
      if (match) listening.resolve(match[1]!);
    }
  }
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]);
  void drains.catch((error) => listening.reject(error));
  void child.exited.then((code) => {
    listening.reject(
      new Error(`Probe child exited (${code}): ${output.replaceAll(token, "[redacted]")}`),
    );
  });
  try {
    const url = await bounded(listening.promise);
    const owner = await Client.connect(url, token, "agentvoice_probe");
    clients.push(owner);
    const attached = await Client.connect(url, token, "codex_tui_probe");
    clients.push(attached);
    const started = await owner.request("thread/start", {
      cwd: workspace,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
    });
    confirmFullAccess(started);
    const threadId = (started["thread"] as Json)["id"] as string;
    console.log("PASS: owned thread starts with confirmed dangerFullAccess / never");

    await attached.request("thread/settings/update", { threadId, approvalPolicy: "on-request" });
    const changed = await owner.settings(threadId);
    assert.equal(changed["approvalPolicy"], "on-request");
    assert.throws(() => confirmFullAccess(changed, true));
    console.log(
      "CONFIRMED BOUNDARY FAILURE: second client changes the owner's approval policy; owner learns after application",
    );

    await owner.request("thread/settings/update", { threadId, approvalPolicy: "never" });
    confirmFullAccess(await owner.settings(threadId), true);
    const extra = await attached.request("thread/start", {
      cwd: workspace,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
    });
    assert.notEqual((extra["thread"] as Json)["id"], threadId);
    console.log(
      "CONFIRMED BOUNDARY FAILURE: server token permits creating another thread; it is not an exact-thread capability",
    );
    console.log("No turns, inference, realtime sessions or audio were started.");
  } finally {
    for (const client of clients) client.socket.close();
    child.kill("SIGTERM");
    try {
      await bounded(child.exited);
    } catch {
      child.kill("SIGKILL");
      await bounded(child.exited);
    }
    await bounded(drains);
  }
}
