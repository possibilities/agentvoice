import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { Composition } from "../src/composition/controller.ts";
import {
  CompositionLayout,
  initialLayout,
  type layoutSchema,
  waiting,
  waitingMessages,
} from "../src/composition/layout.ts";
import type { FrontendObservation } from "../src/frontend/protocol.ts";
import { SocketFailure } from "../src/ipc/control-client.ts";
import { main } from "../src/main.ts";

class FakeMux {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  messages = { hasMessages: () => true, close() {} };
  layout: z.infer<typeof layoutSchema> = {
    ...initialLayout(120),
    stage: { cols: 120, rows: 30 },
    revision: 0,
    panes: [
      { cols: 80, rows: 30 },
      { cols: 39, rows: 30 },
    ],
  };
  conflict = false;
  async request(method: string, raw?: unknown): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === "instance.configure") return {};
    if (method === "layout.get") return structuredClone(this.layout);
    if (method === "layout.apply") {
      if (this.conflict) {
        this.conflict = false;
        this.layout.root.row[0]!.size = 53;
        this.fit();
        this.layout.revision++;
        throw new SocketFailure("Dragged", "conflict");
      }
      this.layout = { ...this.layout, ...params, revision: this.layout.revision + 1 };
      this.fit();
      return this.layout;
    }
    if (method === "app.create") return { name: params["name"], state: "running" };
    throw new Error(method);
  }
  fit() {
    const row = this.layout.root.row;
    const elastic = row.filter((pane) => pane.size === undefined).length;
    const remaining =
      this.layout.stage.cols -
      row.length +
      1 -
      row.reduce((sum, pane) => sum + (pane.size ?? 0), 0);
    this.layout.panes = row.map((pane) => ({
      cols: pane.size ?? Math.floor(remaining / elastic),
      rows: this.layout.stage.rows,
    }));
  }
  created() {
    return this.calls.filter((call) => call.method === "app.create").map((call) => call.params);
  }
}
function live(clientId: string): FrontendObservation {
  return {
    busy: true,
    availability: "connected",
    clientId,
    workspace: "/exact/workspace",
    threadId: "exact-thread",
    state: {
      available: true,
      phase: "live",
      mic: { muted: false, effectiveMuted: false },
      speaker: { muted: false, effectiveMuted: false },
    },
  };
}

test("only this client's live identity starts local attachments, once, with exact selection", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(
    mux,
    id,
    ["bun", "/checkout/main.ts"],
    undefined,
    () => mux.messages,
  );
  await composition.start();
  expect(mux.calls[0]).toEqual({
    method: "instance.configure",
    params: { confirmExit: true },
  });
  expect(mux.created()).toHaveLength(1);
  composition.observe(live(randomUUID()));
  composition.observe({ ...live(id), state: { ...live(id).state!, phase: "negotiating" } });
  await composition.drained();
  expect(mux.created()).toHaveLength(1);
  composition.observe({ ...live(id), threadId: null });
  await composition.drained();
  expect(mux.created()).toHaveLength(1);
  composition.observe(live(id));
  await composition.drained();
  expect(mux.created()).toHaveLength(3);
  for (const app of mux.created()) {
    expect(app["pty"]).toBe("local");
    expect(app["whenHidden"]).toBe("keep");
  }
  expect(mux.created()[1]!["argv"]).toEqual([
    "bun",
    "/checkout/main.ts",
    "attach",
    "voice",
    "--workspace",
    "/exact/workspace",
    "--thread",
    "exact-thread",
  ]);
  expect(mux.created()[2]!["argv"]).toEqual([
    "bun",
    "/checkout/main.ts",
    "attach",
    "agent",
    "--workspace",
    "/exact/workspace",
    "--thread",
    "exact-thread",
  ]);
  composition.observe(live(id));
  await composition.drained();
  expect(mux.created()).toHaveLength(3);
  expect(mux.layout.focus).toBe("agent");
  composition.stop();
});

test("failed startup and client exit never launch attachments", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  composition.observe({
    ...live(id),
    workspace: null,
    threadId: null,
    state: { ...live(id).state!, phase: "failed" },
  });
  await composition.drained();
  expect(mux.created()).toHaveLength(1);
  expect(mux.layout.root.row.map((pane) => pane.text)).toEqual([
    "Voice connection failed",
    waitingMessages,
  ]);
  composition.observe({ ...live(id), state: { ...live(id).state!, phase: "negotiating" } });
  await composition.drained();
  expect(mux.layout.root).toEqual(initialLayout(120).root);
  composition.event({
    type: "event",
    event: "app.state",
    data: { app: { name: "client", state: "exited" } },
  });
  composition.observe(live(id));
  await composition.drained();
  await composition.done;
  expect(mux.created()).toHaveLength(1);
});

test.each([
  ["client", "exited"],
  ["voice", "exited"],
  ["agent", "exited"],
  ["client", "failed"],
  ["voice", "failed"],
  ["agent", "failed"],
])("%s %s ends the composition without relaunching attachments", async (name, state) => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  composition.observe(live(id));
  await composition.drained();
  const callCount = mux.calls.length;
  composition.event({
    type: "event",
    event: "app.state",
    data: { app: { name, state, error: state === "failed" ? "Fixture failure" : null } },
  });
  await composition.done;
  expect(composition.error()?.message).toBe(state === "failed" ? "Fixture failure" : undefined);
  composition.observe({ ...live(id), state: { ...live(id).state!, phase: "negotiating" } });
  composition.observe(live(id));
  await composition.drained();
  expect(mux.calls).toHaveLength(callCount);
  expect(mux.created()).toHaveLength(3);
});

test("attachment exit during startup stops the composition before creating the next app", async () => {
  const mux = new FakeMux();
  const request = mux.request.bind(mux);
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  mux.request = async (method, raw) => {
    const result = await request(method, raw);
    if (method === "app.create" && (raw as Record<string, unknown>)["name"] === "voice") {
      composition.event({
        type: "event",
        event: "app.state",
        data: { app: { name: "voice", state: "exited" } },
      });
    }
    return result;
  };
  await composition.start();
  composition.observe(live(id));
  await composition.drained();
  await composition.done;
  expect(mux.created().map((app) => app["name"])).toEqual(["client", "voice"]);
  expect(mux.layout.root).toEqual(initialLayout(120).root);
});

test("nonterminal app states and unrelated app exits leave the composition running", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  let ended = false;
  void composition.done.then(() => {
    ended = true;
  });
  for (const name of ["client", "voice", "agent"]) {
    for (const state of ["stopped", "starting", "running"]) {
      composition.event({ type: "event", event: "app.state", data: { app: { name, state } } });
    }
  }
  composition.event({
    type: "event",
    event: "app.state",
    data: { app: { name: "unrelated", state: "exited" } },
  });
  composition.observe(live(id));
  await composition.drained();
  expect(ended).toBe(false);
  expect(mux.created()).toHaveLength(3);
  composition.stop();
});

test("placeholder replacement rebases a rejected revision onto the human's divider drag", async () => {
  const mux = new FakeMux();
  mux.conflict = true;
  await new CompositionLayout().update(mux, { connected: true, agent: false });
  expect(mux.layout.root.row).toEqual([
    { app: "client", size: 26 },
    { app: "voice", size: 26 },
    { text: waitingMessages },
  ]);
  expect(mux.calls.filter((call) => call.method === "layout.apply")).toHaveLength(2);
});

test("composition CLI names the pointer-only client explicitly and rejects server flags", async () => {
  expect(await main(["client", "--help"])).toBe(0);
  expect(await main(["client", "--model", "must-not-launch"])).toBe(2);
  expect(await main(["--model", "must-not-launch"])).toBe(2);
});

test("exit configuration failure prevents the voice client from starting", async () => {
  const calls: string[] = [];
  const composition = new Composition(
    {
      async request(method: string) {
        calls.push(method);
        throw new Error("smolmux needs updating");
      },
    },
    randomUUID(),
    ["agentvoice"],
  );
  await expect(composition.start()).rejects.toThrow("smolmux needs updating");
  expect(calls).toEqual(["instance.configure"]);
  composition.stop();
});

test("one combined startup placeholder splits at connection; the agent waits for voice text", async () => {
  const mux = new FakeMux();
  let hasMessages = false;
  let closed = false;
  mux.messages = {
    hasMessages: () => hasMessages,
    close() {
      closed = true;
    },
  };
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  expect(mux.layout.root).toEqual({
    row: [{ text: waiting, size: 80 }, { text: waitingMessages }],
  });
  expect(mux.layout.focus).toBeNull();
  composition.observe(live(id));
  await composition.drained();
  expect(mux.created().map((app) => app["name"])).toEqual(["client", "voice"]);
  expect(mux.layout.root.row.map((pane) => pane.app ?? pane.text)).toEqual([
    "client",
    "voice",
    waitingMessages,
  ]);
  expect(mux.layout.focus).toBe("client");
  hasMessages = true;
  // The first-message poll works without another frontend state event.
  await Bun.sleep(150);
  await composition.drained();
  expect(mux.created().map((app) => app["name"])).toEqual(["client", "voice", "agent"]);
  expect(mux.layout.focus).toBe("agent");
  expect(closed).toBe(true);
  composition.stop();
});

test("redial combines the left panes and restores their dragged division without relaunching", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  composition.observe(live(id));
  await composition.drained();
  mux.layout.root.row[0]!.size = 23;
  mux.layout.root.row[1]!.size = 48;
  mux.fit();
  const connected = structuredClone(mux.layout.root);
  composition.observe({ ...live(id), state: { ...live(id).state!, phase: "negotiating" } });
  await composition.drained();
  expect(mux.layout.root.row).toEqual([{ text: waiting, size: 72 }, { app: "agent" }]);
  composition.observe(live(id));
  await composition.drained();
  expect(mux.layout.root).toEqual(connected);
  expect(mux.created()).toHaveLength(3);
  composition.stop();
});

test("shutdown while waiting for messages cancels observation and cannot start the agent", async () => {
  const mux = new FakeMux();
  let closed = false;
  mux.messages = {
    hasMessages: () => false,
    close() {
      closed = true;
    },
  };
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
  await composition.start();
  composition.observe(live(id));
  await composition.drained();
  composition.stop();
  const calls = mux.calls.length;
  mux.messages.hasMessages = () => true;
  composition.observe(live(id));
  await Bun.sleep(150);
  await composition.drained();
  expect(mux.calls).toHaveLength(calls);
  expect(closed).toBe(true);
});

test.each(["workspace", "threadId"])(
  "a changed %s while waiting cannot attach the agent to a different conversation",
  async (field) => {
    const mux = new FakeMux();
    let closed = false;
    mux.messages = {
      hasMessages: () => false,
      close() {
        closed = true;
      },
    };
    const id = randomUUID();
    const composition = new Composition(mux, id, ["agentvoice"], undefined, () => mux.messages);
    await composition.start();
    composition.observe(live(id));
    await composition.drained();
    mux.messages.hasMessages = () => true;
    composition.observe({ ...live(id), [field]: "different" });
    await composition.drained();
    await composition.done;
    expect(composition.error()?.message).toContain("identity changed");
    expect(mux.created().map((app) => app["name"])).toEqual(["client", "voice"]);
    expect(closed).toBe(true);
  },
);

test("terminal resizing preserves combined and split pane proportions", async () => {
  const mux = new FakeMux();
  const layout = new CompositionLayout(120);
  mux.layout.stage.cols = 48;
  await layout.update(mux, { connected: false, agent: false });
  expect(mux.layout.panes.map((pane) => pane.cols)).toEqual([32, 15]);
  await layout.update(mux, { connected: true, agent: false });
  expect(mux.layout.panes.map((pane) => pane.cols)).toEqual([16, 15, 15]);
  mux.layout.stage.cols = 120;
  await layout.update(mux, { connected: true, agent: false });
  expect(mux.layout.panes.map((pane) => pane.cols)).toEqual([41, 38, 39]);
});
