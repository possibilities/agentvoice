#!/usr/bin/env bun
/** Disposable protocol fixture: native-like durable history, no auth/network/inference. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = process.cwd();
const store = join(root, "native-threads.json");
const threads: Array<Record<string, unknown>> = existsSync(store)
  ? JSON.parse(readFileSync(store, "utf8"))
  : [];
let config: Record<string, unknown> = {};
const full = { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  const params = request.params ?? {};
  appendFileSync(
    join(root, "native-audit.jsonl"),
    `${JSON.stringify({ pid: process.pid, method: request.method, params })}\n`,
  );
  if (request.id === undefined) continue;
  let result: unknown = {};
  if (request.method === "thread/list") result = { data: threads, nextCursor: null };
  if (request.method === "thread/start") {
    const thread = {
      id: `test-thread-${threads.length + 1}`,
      cwd: root,
      threadSource: params.threadSource,
    };
    threads.unshift(thread);
    writeFileSync(store, JSON.stringify(threads));
    config = params.config ?? {};
    result = { thread, ...full, model: params.model ?? "native-default" };
  }
  if (request.method === "thread/read" || request.method === "thread/resume") {
    if (request.method === "thread/resume") config = params.config ?? {};
    result = {
      thread: threads.find((t) => t["id"] === params.threadId),
      ...full,
      model: params.model ?? "native-default",
    };
  }
  if (request.method === "mcpServerStatus/list") {
    const servers = config["mcp_servers"] as Record<string, { enabled_tools?: string[] }>;
    result = {
      data: Object.entries(servers ?? {}).map(([name, server]) => ({
        name,
        runtimeStatus: existsSync(join(root, "fail-mcp")) ? "failed" : "connected",
        authStatus: "bearerToken",
        tools: Object.fromEntries((server.enabled_tools ?? []).map((name) => [name, { name }])),
      })),
      nextCursor: null,
    };
  }
  if (request.method === "thread/timeline/list") result = { data: [], nextCursor: null };
  if (request.method === "turn/start") {
    const mode = existsSync(join(root, "handoff-mode"))
      ? readFileSync(join(root, "handoff-mode"), "utf8")
      : "accepted";
    if (mode === "refused") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: JSON.stringify(params) } })}\n`,
      );
      continue;
    }
    result =
      mode === "malformed" ? { turn: {} } : { turn: { id: "handoff-turn", status: "inProgress" } };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
