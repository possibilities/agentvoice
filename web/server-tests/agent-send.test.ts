import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AttachmentGateway } from "../../src/attachment/gateway.ts";
import { LocalImageStore } from "../../src/attachment/local-images.ts";
import { agentCommandSchema } from "../server/agent-controls.ts";
import { dispatchAgentOperation } from "../server/agent-sender.ts";
import { liveApi } from "../server/api.ts";
import { LiveReader } from "../server/live-reader.ts";
import { fixture } from "./fixture.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlQAAAABJRU5ErkJggg==",
  "base64",
);

async function saveImage(workspace: string, threadId = "main") {
  return new LocalImageStore().save({
    identity: { workspace, threadId },
    requestId: randomUUID(),
    mimeType: "image/png",
    chunks: (async function* () {
      yield PNG;
    })(),
    current: () => true,
  });
}

async function until(
  reader: LiveReader,
  check: (view: Awaited<ReturnType<LiveReader["read"]>>) => boolean,
) {
  let view = await reader.read();
  for (let count = 0; !check(view) && count < 30; count++) {
    await Bun.sleep(260);
    view = await reader.read();
  }
  expect(check(view)).toBe(true);
  return view;
}

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
  let threadStatus: "idle" | "active" | "systemError" | undefined;
  const update = () =>
    h.feed.update({
      complete: true,
      threads: [
        {
          id: "main",
          parentThreadId: null,
          name: null,
          status: threadStatus ?? (turn?.status === "inProgress" ? "active" : "idle"),
          activeFlags: [],
          turn,
        },
      ],
    });
  let hold = false;
  let holdInitialize = false;
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
            if (frame.method === "turn/start") {
              threadStatus = undefined;
              turn = { id: `turn-${++revision}`, status: "inProgress" };
            }
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
        if (
          (!hold || frame.method === "initialize") &&
          !(holdInitialize && frame.method === "initialize")
        )
          answer();
      },
    },
  });
  gateway = new AttachmentGateway({
    url: `ws://127.0.0.1:${native.port}`,
    token: "fake-native-token",
  });
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
    holdInitialize: () => {
      holdInitialize = true;
    },
    answer: () => answer(),
    complete: (status: "completed" | "interrupted" = "interrupted") => {
      if (turn) turn = { ...turn, status };
      threadStatus = undefined;
      update();
      h.feed.conversation({
        event: "conversation.turn.completed",
        revision: ++revision,
        data: { threadId: "main", turn: { ...turn, items: [], error: null } },
      });
    },
    systemError: (terminal = true, retainInProgressInventory = false) => {
      threadStatus = "systemError";
      const completedTurn = terminal && turn ? { ...turn, status: "failed" as const } : turn;
      if (!retainInProgressInventory) turn = completedTurn;
      update();
      if (terminal)
        h.feed.conversation({
          event: "conversation.turn.completed",
          revision: ++revision,
          data: { threadId: "main", turn: { ...completedTurn, items: [], error: null } },
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

test("detached web Agent send and steer reach the retained exact native thread", async () => {
  const h = await agentFixture();
  try {
    const attached = await h.reader.read();
    await h.hangup();
    const view = await until(h.reader, (current) => current.phase === "detached");
    expect(view.id).toBe(attached.id);
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

test("a failed system-error turn re-enables Send without trusting a still-running turn", async () => {
  const h = await agentFixture();
  try {
    const first = await h.reader.read();
    await h.reader.agentCommand(
      agentCommandSchema.parse({
        viewId: first.id,
        requestId: randomUUID(),
        action: "send",
        text: "Reach the quota boundary",
      }),
    );

    h.systemError(false);
    const unresolved = await until(h.reader, (view) => view.agentControls?.available === false);
    expect(unresolved.agentControls?.active).toBe(true);

    h.systemError(true, true);
    const recovered = await until(
      h.reader,
      (view) => view.agentControls?.available === true && !view.agentControls.active,
    );
    expect(recovered.id).toBe(first.id);
    await h.reader.agentCommand(
      agentCommandSchema.parse({
        viewId: recovered.id,
        requestId: randomUUID(),
        action: "send",
        text: "Retry after quota recovery",
      }),
    );
    expect(h.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("absolute file references remain one exact native text part for send, steer and queued dispatch", async () => {
  const h = await agentFixture();
  try {
    const view = await h.reader.read();
    const text = "Inspect @/Users/operator/design reference.png\n@/Users/operator/notes.md";
    const command = (action: string) =>
      agentCommandSchema.parse({
        viewId: view.id,
        requestId: randomUUID(),
        action,
        text,
      });
    await h.reader.agentCommand(command("send"));
    await h.reader.agentCommand(command("steer"));
    await h.reader.agentCommand(command("queue"));
    h.complete("completed");
    for (
      let n = 0;
      n < 200 && h.calls.filter((call) => call.method === "turn/start").length < 2;
      n++
    )
      await Bun.sleep(5);
    const dispatched = h.calls.filter(
      (call) => call.method === "turn/start" || call.method === "turn/steer",
    );
    expect(dispatched.map((call) => call.method)).toEqual([
      "turn/start",
      "turn/steer",
      "turn/start",
    ]);
    for (const call of dispatched)
      expect(call.params.input).toEqual([{ type: "text", text, text_elements: [] }]);
  } finally {
    await h.close();
  }
});

test("verified clipboard images reach native first in exact order with an optional text tail", async () => {
  const h = await agentFixture();
  try {
    const view = await h.reader.read();
    const first = await saveImage(h.root);
    const second = await saveImage(h.root);
    const paths = [{ path: second.path }, { path: first.path }];
    const send = agentCommandSchema.parse({
      viewId: view.id,
      requestId: randomUUID(),
      action: "send",
      text: "Compare these",
      images: paths,
    });
    await h.reader.agentCommand(send);
    const start = h.calls.find((call) => call.method === "turn/start")!;
    expect(start.params).toEqual({
      threadId: "main",
      clientUserMessageId: send.requestId,
      input: [
        { type: "localImage", path: second.path, detail: null },
        { type: "localImage", path: first.path, detail: null },
        { type: "text", text: "Compare these", text_elements: [] },
      ],
    });

    const steer = agentCommandSchema.parse({
      viewId: view.id,
      requestId: randomUUID(),
      action: "steer",
      text: "",
      images: [{ path: first.path }],
    });
    await h.reader.agentCommand(steer);
    const nativeSteer = h.calls.find((call) => call.method === "turn/steer")!;
    expect(nativeSteer.params).toEqual({
      threadId: "main",
      expectedTurnId: "turn-1",
      clientUserMessageId: steer.requestId,
      input: [{ type: "localImage", path: first.path, detail: null }],
    });
  } finally {
    await h.close();
  }
});

test("detached queued input dispatches on native completion without browser polling", async () => {
  const h = await agentFixture();
  try {
    const attached = await h.reader.read();
    await h.hangup();
    const view = await until(h.reader, (current) => current.phase === "detached");
    expect(view.id).toBe(attached.id);
    expect(view.agentControls?.available).toBe(true);
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

test("detached actions reject once the retained event transport is unreachable", async () => {
  const h = await agentFixture();
  try {
    const attached = await h.reader.read();
    await h.hangup();
    const detached = await until(h.reader, (view) => view.phase === "detached");
    expect(detached.id).toBe(attached.id);
    h.stopEvents();
    const unavailable = await until(h.reader, (view) => view.phase === "unavailable");
    expect(unavailable.agentControls?.available).toBe(false);
    await expect(
      h.reader.agentCommand(
        agentCommandSchema.parse({
          viewId: unavailable.id,
          requestId: randomUUID(),
          action: "send",
          text: "Must remain local",
        }),
      ),
    ).rejects.toThrow("call changed");
    expect(h.calls.some((call) => call.method === "turn/start")).toBe(false);
  } finally {
    await h.close();
  }
});

test("a detached action waiting on native initialization cannot cross a replacement", async () => {
  const h = await agentFixture();
  try {
    const attached = await h.reader.read();
    await h.hangup();
    const detached = await until(h.reader, (view) => view.phase === "detached");
    expect(detached.id).toBe(attached.id);
    h.holdInitialize();
    const result = h.reader.agentCommand(
      agentCommandSchema.parse({
        viewId: detached.id,
        requestId: randomUUID(),
        action: "send",
        text: "Must not cross replacement",
      }),
    );
    for (
      let count = 0;
      count < 200 && !h.calls.some((call) => call.method === "initialize");
      count++
    )
      await Bun.sleep(5);
    expect(h.calls.some((call) => call.method === "initialize")).toBe(true);
    h.replace("successor");
    await Bun.sleep(20);
    h.answer();
    await expect(result).rejects.toMatchObject({ delivery: "not-sent" });
    expect(h.calls.some((call) => call.method === "turn/start")).toBe(false);
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
    const attached = await h.reader.read();
    await h.hangup();
    const view = await until(h.reader, (current) => current.phase === "detached");
    expect(view.id).toBe(attached.id);
    expect(view.agentControls?.available).toBe(true);
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
