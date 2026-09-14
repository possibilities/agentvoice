import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AttachmentGateway } from "../../src/attachment/gateway.ts";
import { agentCommandSchema } from "../server/agent-controls.ts";
import { dispatchAgentOperation } from "../server/agent-sender.ts";
import { liveApi } from "../server/api.ts";
import { LiveReader } from "../server/live-reader.ts";
import { fixture } from "./fixture.ts";

async function agentFixture() {
  let gateway: AttachmentGateway;
  const h = await fixture(async (target) => {
    expect(target).toEqual({
      instanceId: h.feed.snapshot().instanceId,
      generation: 1,
      workspace: h.root,
      threadId: "main",
    });
    return gateway.issue({ workspace: h.root, threadId: "main" });
  });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let revision = 0;
  let turn: { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" } | null =
    null;
  const update = () =>
    h.feed.update({
      complete: true,
      threads: [
        {
          id: "main",
          parentThreadId: null,
          name: null,
          status: turn?.status === "inProgress" ? "active" : "idle",
          activeFlags: [],
          turn,
        },
      ],
    });
  let hold = false;
  let answer = () => {};
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer fake-native-token")
        return new Response("Forbidden", { status: 403 });
      if (!server.upgrade(request)) return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      message(peer, data) {
        const frame = JSON.parse(String(data));
        calls.push(frame);
        if (!frame.id) return;
        answer = () => {
          let result: unknown = {};
          if (frame.method === "turn/start" || frame.method === "turn/steer") {
            if (frame.method === "turn/start")
              turn = { id: `turn-${++revision}`, status: "inProgress" };
            result = frame.method === "turn/start" ? { turn } : { turnId: turn?.id };
            update();
            h.feed.conversation({
              event: "conversation.turn.started",
              revision: ++revision,
              data: { threadId: "main", turn: { ...turn, items: [], error: null } },
            });
          } else if (frame.method === "turn/interrupt") {
            expect(frame.params.turnId).toBe(turn?.id);
            // Acknowledgment precedes the terminal notification, as on the real app-server.
          }
          peer.send(JSON.stringify({ id: frame.id, result }));
        };
        if (!hold || frame.method === "initialize") answer();
      },
    },
  });
  gateway = new AttachmentGateway(
    { url: `ws://127.0.0.1:${native.port}`, token: "fake-native-token" },
    process.execPath,
    async () => ({ id: "main", cwd: h.root, parentThreadId: null }),
  );
  update();
  await h.start();
  const reader = new LiveReader(h.stateDir);
  return {
    ...h,
    reader,
    calls,
    gateway,
    hold: () => {
      hold = true;
    },
    answer: () => answer(),
    complete: (status: "completed" | "interrupted" = "interrupted") => {
      if (turn) turn = { ...turn, status };
      update();
      h.feed.conversation({
        event: "conversation.turn.completed",
        revision: ++revision,
        data: { threadId: "main", turn: { ...turn, items: [], error: null } },
      });
    },
    close: async () => {
      reader.close();
      gateway.close();
      native.stop(true);
      await h.close();
    },
  };
}

test("web Agent commands reach the exact native thread through the real attachment gateway", async () => {
  const h = await agentFixture();
  try {
    const view = await h.reader.read();
    expect(view.agentControls?.available).toBe(true);
    const command = (fields: object) =>
      agentCommandSchema.parse({ viewId: view.id, requestId: randomUUID(), ...fields });
    const send = command({ action: "send", text: "Typed text\nwith a second line" });
    await h.reader.agentCommand(send);
    const start = h.calls.find((call) => call.method === "turn/start")!;
    expect(start.params.threadId).toBe("main");
    expect(start.params.clientUserMessageId).toBe(send.requestId);
    expect(start.params.input).toEqual([
      { type: "text", text: "Typed text\nwith a second line", text_elements: [] },
    ]);
    expect(Object.keys(start.params).sort()).toEqual(["clientUserMessageId", "input", "threadId"]);
    await h.reader.agentCommand(command({ action: "steer", text: "Apply this now" }));
    expect(h.calls.find((call) => call.method === "turn/steer")?.params.expectedTurnId).toBe(
      "turn-1",
    );
    await h.reader.agentCommand(command({ action: "interrupt" }));
    expect(h.calls.find((call) => call.method === "turn/interrupt")?.params).toEqual({
      threadId: "main",
      turnId: "turn-1",
    });
    expect((await h.reader.read()).agentControls?.stopping).toBe(true);
    h.complete();
    await Bun.sleep(260);
    expect((await h.reader.read()).agentControls?.stopping).toBe(false);
    expect(h.counts()).toEqual({ starts: 1, closes: 0 });
    expect(
      h.calls.some((call) => /account|thread\/start|thread\/resume|realtime/.test(call.method)),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

test("queued input dispatches on native completion without browser polling", async () => {
  const h = await agentFixture();
  try {
    const view = await h.reader.read();
    const command = (fields: object) =>
      agentCommandSchema.parse({ viewId: view.id, requestId: randomUUID(), ...fields });
    await h.reader.agentCommand(command({ action: "send", text: "First turn" }));
    await h.reader.agentCommand(command({ action: "queue", text: "After this" }));
    h.complete("completed");
    for (
      let n = 0;
      n < 200 && h.calls.filter((call) => call.method === "turn/start").length < 2;
      n++
    )
      await Bun.sleep(5);
    expect(h.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("revocation after dispatch reports unknown delivery and never retries", async () => {
  const h = await agentFixture();
  try {
    h.hold();
    const ticket = h.gateway.issue({ workspace: h.root, threadId: "main" });
    const result = dispatchAgentOperation(
      ticket,
      { action: "send", text: "Once only" },
      () => true,
      750,
    );
    const rejected = expect(result).rejects.toMatchObject({ delivery: "unknown" });
    for (let n = 0; n < 200 && !h.calls.some((call) => call.method === "turn/start"); n++)
      await Bun.sleep(5);
    h.gateway.revoke();
    await rejected;
    expect(h.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("Agent HTTP writes require exact origin, JSON, bounded fields and the current view", async () => {
  const h = await agentFixture();
  const server = createServer((request, response) =>
    liveApi(h.reader)(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const view = await h.reader.read();
    const command = { viewId: view.id, requestId: randomUUID(), action: "send", text: "From HTTP" };
    const send = (body: object, headers = { Origin: origin, "Content-Type": "application/json" }) =>
      fetch(`${origin}/api/agent`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(
      (
        await send(command, {
          Origin: "https://foreign.example",
          "Content-Type": "application/json",
        })
      ).status,
    ).toBe(403);
    expect((await send(command, { Origin: origin, "Content-Type": "text/plain" })).status).toBe(
      403,
    );
    expect((await send(command, { Origin: "", "Content-Type": "application/json" })).status).toBe(
      403,
    );
    expect((await send({ ...command, threadId: "foreign" })).status).toBe(400);
    expect((await send({ ...command, text: "x".repeat(65537) })).status).toBe(400);
    expect((await send({ ...command, viewId: randomUUID(), requestId: randomUUID() })).status).toBe(
      409,
    );
    expect(h.calls).toEqual([]);
    expect((await send(command)).status).toBe(200);
    expect((await send(command)).status).toBe(200);
    expect(h.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  }
});
