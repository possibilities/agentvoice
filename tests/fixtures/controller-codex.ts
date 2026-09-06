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
const loaded = new Set<string>();
const full = { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
function handle(line: string, send: (text: string) => void) {
  const request = JSON.parse(line);
  const params = request.params ?? {};
  appendFileSync(
    join(root, "native-audit.jsonl"),
    `${JSON.stringify({ pid: process.pid, method: request.method, params })}\n`,
  );
  if (request.id === undefined) return;
  let result: unknown = {};
  if (request.method === "thread/list") result = { data: threads, nextCursor: null };
  if (request.method === "thread/loaded/list") result = { data: [...loaded], nextCursor: null };
  if (request.method === "thread/start") {
    const thread = {
      id: `test-thread-${threads.length + 1}`,
      cwd: root,
      threadSource: params.threadSource,
      status: { type: "idle" },
    };
    threads.unshift(thread);
    loaded.add(thread.id);
    writeFileSync(store, JSON.stringify(threads));
    config = params.config ?? {};
    result = { thread, ...full, model: params.model ?? "native-default" };
  }
  if (request.method === "thread/read" || request.method === "thread/resume") {
    if (request.method === "thread/resume") {
      if (params.config) config = params.config;
      loaded.add(params.threadId);
    }
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
  if (request.method === "turn/start") {
    const mode = existsSync(join(root, "handoff-mode"))
      ? readFileSync(join(root, "handoff-mode"), "utf8")
      : "accepted";
    if (mode === "refused") {
      send(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: JSON.stringify(params) } })}\n`,
      );
      return;
    }
    result =
      mode === "malformed" ? { turn: {} } : { turn: { id: "handoff-turn", status: "inProgress" } };
  }
  send(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  if (request.method === "turn/start" && (result as { turn?: { id?: string } }).turn?.id) {
    const item = {
      id: "voice-fixture-item",
      realtimeSessionId: "native-session",
      type: "transcriptSegment",
      role: "assistant",
      text: "",
    };
    for (const [method, data] of [
      ["thread/realtime/item/started", { threadId: params.threadId, item }],
      [
        "thread/realtime/item/transcript/delta",
        { threadId: params.threadId, itemId: item.id, delta: "native voice fixture" },
      ],
      [
        "thread/realtime/item/completed",
        { threadId: params.threadId, item: { ...item, text: "native voice fixture" } },
      ],
    ])
      send(`${JSON.stringify({ method, params: data })}\n`);
    send(
      `${JSON.stringify({ method: "turn/started", params: { threadId: params.threadId, turn: (result as { turn: unknown }).turn } })}\n`,
    );
    send(
      `${JSON.stringify({ method: "thread/status/changed", params: { threadId: params.threadId, status: { type: "active", activeFlags: [] } } })}\n`,
    );
  }
}

const listen = process.argv[process.argv.indexOf("--listen") + 1];
if (listen === "ws://127.0.0.1:0") {
  const token = readFileSync(process.argv[process.argv.indexOf("--ws-token-file") + 1]!, "utf8");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("unauthorized", { status: 401 });
      if (!server.upgrade(request)) return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(peer, text) {
        handle(String(text), (response) => peer.send(response.trim()));
      },
    },
  });
  console.log(`listening on: ws://127.0.0.1:${server.port}`);
} else {
  const input = createInterface({ input: process.stdin });
  for await (const line of input) handle(line, (response) => process.stdout.write(response));
}
