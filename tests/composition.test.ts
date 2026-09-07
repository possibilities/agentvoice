import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Composition } from "../src/composition/controller.ts";
import { initialLayout, replacePane } from "../src/composition/layout.ts";
import type { FrontendObservation } from "../src/frontend/protocol.ts";
import { SocketFailure } from "../src/ipc/control-client.ts";
import { main } from "../src/main.ts";

class FakeMux {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  layout = {
    ...initialLayout(),
    revision: 0,
    panes: [
      { cols: 40, rows: 30 },
      { cols: 40, rows: 30 },
      { cols: 40, rows: 30 },
    ],
  };
  conflict = false;
  async request(method: string, raw?: unknown): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === "layout.get") return structuredClone(this.layout);
    if (method === "layout.apply") {
      if (this.conflict) {
        this.conflict = false;
        this.layout.root.row[0] = { app: "client", size: 53 } as (typeof this.layout.root.row)[0];
        this.layout.revision++;
        throw new SocketFailure("Dragged", "conflict");
      }
      this.layout = { ...this.layout, ...params, revision: this.layout.revision + 1 };
      return this.layout;
    }
    if (method === "app.create") return { name: params["name"], state: "running" };
    throw new Error(method);
  }
  created() {
    return this.calls.filter((call) => call.method === "app.create").map((call) => call.params);
  }
}
function live(clientId: string): FrontendObservation {
  return {
    busy: true,
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
  const composition = new Composition(mux, id, ["bun", "/checkout/main.ts"]);
  await composition.start();
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
  const composition = new Composition(mux, id, ["agentvoice"]);
  await composition.start();
  composition.observe({ ...live(id), state: { ...live(id).state!, phase: "failed" } });
  await composition.drained();
  expect(mux.created()).toHaveLength(1);
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

test("attachment exit replaces only its pane and never relaunches after runtime restart", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"]);
  await composition.start();
  composition.observe(live(id));
  await composition.drained();
  composition.event({
    type: "event",
    event: "app.state",
    data: { app: { name: "agent", state: "exited" } },
  });
  await composition.drained();
  expect(mux.layout.root.row[2]).toMatchObject({ text: "Agent disconnected" });
  composition.observe(live(id));
  await composition.drained();
  expect(mux.created()).toHaveLength(3);
  composition.stop();
});

test("placeholder replacement rebases a rejected revision onto the human's divider drag", async () => {
  const mux = new FakeMux();
  mux.conflict = true;
  await replacePane(mux, 1, { app: "voice" });
  expect(mux.layout.root.row[0]).toMatchObject({ size: 53 });
  expect(mux.layout.root.row[1]).toMatchObject({ app: "voice" });
  expect(mux.calls.filter((call) => call.method === "layout.apply")).toHaveLength(2);
});

test("composition CLI names the pointer-only client explicitly and rejects server flags", async () => {
  expect(await main(["client", "--help"])).toBe(0);
  expect(await main(["client", "--model", "must-not-launch"])).toBe(2);
  expect(await main(["--model", "must-not-launch"])).toBe(2);
});
