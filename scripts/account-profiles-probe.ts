#!/usr/bin/env bun
/**
 * Upstream-semantics probe for account profiles: a thread started by an
 * app-server under one profile home (a symlink farm over the canonical
 * `~/.codex`) must resume under a different profile home, because rollouts
 * land in the canonical session store both homes link to. Re-run before
 * bumping the supported codex version.
 *
 * Both probe homes symlink everything, auth.json included — one credential
 * lineage, so the probe cannot fork refresh-token rotation. Real profiles
 * differ only in holding a real per-account auth.json.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  buildDenialResponse,
  frameNotification,
  frameRequest,
  frameResponse,
  parseFrames,
  spawnArgv,
} from "../src/core/appserver.ts";

const CODEX_HOME = process.env["CODEX_HOME"] ?? join(process.env["HOME"] ?? "", ".codex");
const TURN_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 30_000;

function buildFarm(root: string, name: string): string {
  const farm = join(root, name);
  rmSync(farm, { recursive: true, force: true });
  Bun.spawnSync(["mkdir", "-p", farm]);
  for (const entry of readdirSync(CODEX_HOME)) {
    symlinkSync(join(CODEX_HOME, entry), join(farm, entry));
  }
  return farm;
}

interface Rpc {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  waitForNotification(
    method: string,
    match: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
  stderrTail(): string;
}

function startAppServer(codexHome: string, cwd: string): Rpc {
  const child: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(spawnArgv("codex"), {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let nextId = 1;
  let stdoutBuffer = "";
  const stderrLines: string[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const waiters: Array<{
    method: string;
    match: (params: Record<string, unknown>) => boolean;
    resolve(params: Record<string, unknown>): void;
  }> = [];

  function write(text: string): void {
    child.stdin.write(text);
    child.stdin.flush();
  }

  function dispatch(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;
    const id = message["id"];
    const method = message["method"];
    if (id !== undefined && method === undefined) {
      const entry = pending.get(id as number);
      if (!entry) return;
      pending.delete(id as number);
      const error = message["error"] as { message?: string } | undefined;
      if (error) entry.reject(new Error(error.message ?? "app-server error"));
      else entry.resolve(message["result"]);
      return;
    }
    if (id !== undefined && typeof method === "string") {
      write(frameResponse(id as number | string, buildDenialResponse(method)));
      return;
    }
    if (typeof method === "string") {
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      for (let index = 0; index < waiters.length; index++) {
        const waiter = waiters[index];
        if (waiter && waiter.method === method && waiter.match(params)) {
          waiters.splice(index, 1);
          waiter.resolve(params);
          return;
        }
      }
    }
  }

  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdoutBuffer += decoder.decode(chunk, { stream: true });
      const { frames, rest } = parseFrames(stdoutBuffer);
      stdoutBuffer = rest;
      for (const frame of frames) dispatch(frame);
    }
  })();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stderr) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      stderrLines.push(...lines.filter((line) => line.trim().length > 0));
    }
  })();

  return {
    request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        write(frameRequest(id, method, params));
      });
    },
    notify(method, params) {
      write(frameNotification(method, params));
    },
    waitForNotification(method, match, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no ${method} within ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({
          method,
          match,
          resolve: (params) => {
            clearTimeout(timer);
            resolve(params);
          },
        });
      });
    },
    async stop() {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      const exited = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      if (exited === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
    stderrTail: () => stderrLines.slice(-8).join("\n"),
  };
}

async function initialize(rpc: Rpc): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "agentvoice-probe", title: "AgentVoice probe", version: "0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  rpc.notify("initialized", {});
  await rpc.request("account/read", {}).then(
    (result) => {
      const account = (result as { account?: { email?: string } }).account;
      console.log(`  auth through farm: ${account?.email ?? "(no email)"}`);
    },
    () => console.log("  account/read unavailable (non-fatal)"),
  );
}

async function runTurn(rpc: Rpc, threadId: string, text: string): Promise<void> {
  const turn = (await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  })) as { turn?: { id?: string } };
  if (!turn?.turn?.id) throw new Error("turn/start returned no turn id");
  await rpc.waitForNotification(
    "turn/completed",
    (params) => params["threadId"] === threadId,
    TURN_TIMEOUT_MS,
  );
}

const root = mkdtempSync(join(tmpdir(), "agentvoice-profile-probe-"));
const cwd = join(root, "cwd");
Bun.spawnSync(["mkdir", "-p", cwd]);
let failed = false;
try {
  const farmA = buildFarm(root, "profile-a");
  const farmB = buildFarm(root, "profile-b");

  console.log("phase 1: thread/start + turn under profile A");
  const serverA = startAppServer(farmA, cwd);
  let threadId: string;
  try {
    await initialize(serverA);
    const started = (await serverA.request("thread/start", {})) as { thread?: { id?: string } };
    const id = started?.thread?.id;
    if (!id) throw new Error("thread/start returned no thread id");
    threadId = id;
    console.log(`  thread ${threadId}`);
    await runTurn(serverA, threadId, "Reply with exactly: ok");
    console.log("  turn completed under profile A");
  } catch (error) {
    console.error(`  stderr tail:\n${serverA.stderrTail()}`);
    throw error;
  } finally {
    await serverA.stop();
  }

  const sessionsDir = join(CODEX_HOME, "sessions");
  const found = Bun.spawnSync(["find", sessionsDir, "-name", `*${threadId}*`]);
  const rolloutPath = found.stdout.toString().trim().split("\n")[0] ?? "";
  if (rolloutPath.length === 0) throw new Error("no rollout in the canonical session store");
  console.log(`  rollout in canonical store: ${rolloutPath}`);
  if (!readFileSync(rolloutPath, "utf8").includes("Reply with exactly: ok")) {
    throw new Error("rollout does not contain the probe turn");
  }

  console.log("phase 2: thread/resume + turn under profile B");
  const serverB = startAppServer(farmB, cwd);
  try {
    await initialize(serverB);
    const resumed = (await serverB.request("thread/resume", {
      threadId,
      excludeTurns: true,
    })) as { thread?: { id?: string } };
    if (resumed?.thread?.id !== threadId) {
      throw new Error(`thread/resume returned ${resumed?.thread?.id ?? "nothing"}`);
    }
    await runTurn(serverB, threadId, "Reply with exactly: ok2");
    console.log("  resumed thread ran a turn under profile B");
  } catch (error) {
    console.error(`  stderr tail:\n${serverB.stderrTail()}`);
    throw error;
  } finally {
    await serverB.stop();
  }

  console.log("PASS: cross-profile resume through the symlink farm");
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
