import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { CONTROL_PROTOCOL_VERSION, startControlServer } from "../src/control/index.ts";
import { eventSocketFrameSchema } from "../src/events/schema.ts";
import { EventSocketServer, eventSocketPath } from "../src/events/socket.ts";
import { type InFlight, type WakeRequest, wakeNotice } from "../src/mailbox/contract.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";

const at = "2026-09-07T03:00:00.000Z";
const completion = (turnId: string) => ({
  threadId: "child",
  turnId,
  name: "child",
  agentPath: "/root/child",
  waitingOn: [],
  status: "completed",
  observedAt: at,
});
const inventory = (): InFlight => ({
  revision: 1,
  threads: [
    {
      threadId: "busy-child",
      turnId: "busy-turn",
      name: "busy",
      agentPath: "/root/busy",
      waitingOn: [],
    },
  ],
  complete: true,
  observedAt: at,
});
async function setup() {
  const directory = mkdtempSync("/tmp/av-mailbox-controller-");
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const wakes: WakeRequest[] = [];
  let snapshotRead: Promise<InFlight> | undefined;
  let mode: "accepted" | "refused" | "unknown" = "accepted";
  const c = new RuntimeController({
    instanceId: "instance",
    stateDir: directory,
    version: "test",
    provenance: {
      parsed: parseArgs([]),
      options: { debug: false, fresh: false, continue: false },
      launchCwd: directory,
    },
    control: { name: "agentvoice_control", server: {}, tools: [], env: {} },
    lease: () => () => {},
    spawn: (_generation, event, lease) => {
      callbacks.push(event);
      const number = callbacks.length;
      const exit = Promise.withResolvers<void>();
      return {
        pid: number,
        nativePid: undefined,
        exited: exit.promise,
        notify() {},
        stop: async () => {
          exit.resolve();
          return false;
        },
        request: async <T>(method: string, input?: unknown): Promise<T> => {
          if (method === "preflight")
            return { workspace: directory, pid: number, buildId: "test" } as T;
          if (method === "activate") {
            await lease("root");
            event("identity", { threadId: "root", workspace: directory });
          }
          if (method === "mailbox-snapshot")
            return (snapshotRead ? await snapshotRead : inventory()) as T;
          if (method === "mailbox-authorize")
            return ((input as { callId: string }).callId === "known-native-call") as T;
          if (method === "mailbox-wake") {
            const request = input as WakeRequest;
            wakes.push(request);
            event("mailbox", { kind: "submitting", notice: wakeNotice(request, inventory()) });
            if (mode === "unknown") throw new Error("response lost");
            if (mode === "refused") return { status: "refused" } as T;
            event("mailbox", {
              kind: "recorded",
              eventId: request.eventId,
              turnId: "active-parent",
              itemId: `item-${wakes.length}`,
            });
            return { status: "accepted", turnId: "active-parent" } as T;
          }
          return null as T;
        },
      };
    },
  });
  await c.start();
  const emit = (turnId: string, callback = callbacks.at(-1)!) =>
    callback("mailbox", { kind: "completed", completion: completion(turnId) });
  return {
    c,
    directory,
    wakes,
    callbacks,
    emit,
    holdSnapshot: (value?: Promise<InFlight>) => {
      snapshotRead = value;
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    close: async () => {
      await c.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("controller immediately submits each completion, consumes concurrent arrivals once, and never retries unknown acceptance", async () => {
  const h = await setup();
  try {
    h.emit("one");
    h.emit("two");
    h.emit("one");
    expect(h.wakes.map((w) => w.completed)).toEqual([1, 2]);
    const wait = Promise.withResolvers<InFlight>();
    h.holdSnapshot(wait.promise);
    const args = { expectedInstanceId: "instance", operationId: "open" };
    const first = h.c.mailboxOpen(args);
    const retry = h.c.mailboxOpen(args);
    h.emit("three");
    wait.resolve(inventory());
    const [a, b] = await Promise.all([first, retry]);
    expect(a).toEqual(b);
    expect(a.entries.map((e) => e.turnId)).toEqual(["one", "two", "three"]);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(0);
    expect(a.inFlightTotal).toBe(1);
    h.mode("unknown");
    h.emit("four");
    await Bun.sleep(1);
    expect(h.c.lifecycle.mailboxSnapshot().state.recentWakes.at(-1)?.status).toBe("unknown");
    expect(await h.c.mailboxOpen(args)).toEqual(a);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(1);
    h.callbacks[0]!("mailbox", { kind: "inventory", inventory: inventory() });
    expect(h.wakes).toHaveLength(4);
    await expect(h.c.mailboxOpen({ ...args, expectedInstanceId: "other" })).rejects.toMatchObject({
      code: "instance_mismatch",
    });
  } finally {
    await h.close();
  }
});

test("mailbox survives exact runtime replacement, while delayed old events and reads cannot consume successor state", async () => {
  const h = await setup();
  const wait = Promise.withResolvers<InFlight>();
  try {
    h.emit("saved");
    h.holdSnapshot(wait.promise);
    const opening = h.c.mailboxOpen({
      expectedInstanceId: "instance",
      operationId: "racing-restart",
    });
    const settled = Promise.allSettled([opening]);
    await h.c.restart({
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      operationId: "restart",
      scope: "runtime",
    });
    for (let n = 0; n < 100 && h.c.status().currentOperation?.phase !== "ready"; n++)
      await Bun.sleep(5);
    expect(h.c.status().generation).toBe(2);
    h.emit("obsolete", h.callbacks[0]);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(1);
    wait.resolve(inventory());
    expect((await settled)[0]?.status).toBe("rejected");
    h.holdSnapshot();
    h.emit("new");
    expect(
      (
        await h.c.mailboxOpen({ expectedInstanceId: "instance", operationId: "current" })
      ).entries.map((e) => e.turnId),
    ).toEqual(["saved", "new"]);
    await h.c.shutdown();
    h.emit("shutdown");
    expect(h.wakes).toHaveLength(2);
  } finally {
    wait.resolve(inventory());
    await h.close();
  }
});

async function socketRequest(path: string, method: string, params: unknown, v = 2) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ v, type: "request", id: "request", method, params })}\n`),
    );
    socket.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      const result = JSON.parse(text.slice(0, end));
      if (v === 2) expect(eventSocketFrameSchema.safeParse(result).success).toBe(true);
      resolve(result);
    });
  });
}

test("read-only event inspection never clears; MCP opening and Unix control share instance, retry, and native caller checks", async () => {
  const h = await setup();
  const server = await startControlServer({
    backend: h.c,
    stateDir: h.directory,
    instanceId: "instance",
  });
  const events = new EventSocketServer(eventSocketPath(h.directory, "instance"), h.c.lifecycle);
  await events.start();
  let sessionId: string | null = null;
  const rpc = async (body: unknown) => {
    const response = await fetch(server.httpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.bearerToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionId ??= response.headers.get("mcp-session-id");
    const text = await response.text();
    const data = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text) as {
      result: { isError?: boolean; structuredContent?: unknown };
    };
  };
  try {
    h.emit("one");
    const params = { expectedInstanceId: "instance" };
    expect((await socketRequest(events.path, "mailbox.get", params))["ok"]).toBe(true);
    expect(
      (await socketRequest(events.path, "mailbox.replay", { ...params, afterSequence: 0 }))["ok"],
    ).toBe(true);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(1);
    expect(
      (
        await socketRequest(events.path, "agentvoice.thread_mailbox_open", {
          ...params,
          operationId: "forbidden",
        })
      )["ok"],
    ).toBe(false);
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const open = { ...params, operationId: "open" };
    const toolCall = (threadId: string, callId: string, n: number) =>
      rpc({
        jsonrpc: "2.0",
        id: n,
        method: "tools/call",
        params: {
          name: "agentvoice_thread_mailbox_open",
          arguments: open,
          _meta: { threadId, callId },
        },
      });
    expect((await toolCall("child", "known-native-call", 2)).result.isError).toBe(true);
    expect((await toolCall("root", "forged-call", 3)).result.isError).toBe(true);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(1);
    const accepted = await toolCall("root", "known-native-call", 4);
    expect(accepted.result.isError).not.toBe(true);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(0);
    h.emit("two");
    const retried = await socketRequest(
      server.socketPath,
      "agentvoice.thread_mailbox_open",
      open,
      CONTROL_PROTOCOL_VERSION,
    );
    expect(retried["result"]).toEqual(accepted.result.structuredContent);
    expect(h.c.lifecycle.mailboxSnapshot().state.completed).toBe(1);
  } finally {
    events.close();
    await server.close();
    await h.close();
  }
});
