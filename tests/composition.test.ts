import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AttachmentIdentity } from "../src/attachment/session.ts";
import { attachmentSshArgv } from "../src/attachment/ssh.ts";
import { AttachmentComposition } from "../src/composition/attachment.ts";
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
    if (method === "instance.configure") return {};
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
  const composition = new Composition(mux, id, ["bun", "/checkout/main.ts"]);
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
  const composition = new Composition(mux, id, ["agentvoice"]);
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
  const composition = new Composition(mux, id, ["agentvoice"]);
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
  expect(mux.layout.root).toEqual(initialLayout().root);
});

test("nonterminal app states and unrelated app exits leave the composition running", async () => {
  const mux = new FakeMux();
  const id = randomUUID();
  const composition = new Composition(mux, id, ["agentvoice"]);
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

const attachedIdentity: AttachmentIdentity = {
  clientId: randomUUID(),
  workspace: "/exact/mobile workspace",
  threadId: "mobile-thread",
  instanceId: "mobile-call",
  generation: 1,
};
test.each([undefined, "smolbird"])(
  "two-pane view on %s starts only the pinned agent and desktop transcript",
  async (host) => {
    const mux = new FakeMux();
    const composition = new AttachmentComposition(mux, ["bun", "/checkout/main.ts"], host);
    let transcript: string | undefined;
    try {
      await composition.start();
      expect(mux.layout.root.row).toHaveLength(2);
      expect(mux.created()).toHaveLength(0);
      const session = {
        v: 1 as const,
        type: "session" as const,
        identity: attachedIdentity,
        phase: "starting",
        agentReady: true,
      };
      await composition.receive(session);
      const args = ["__attach-agent", JSON.stringify(attachedIdentity)];
      expect(mux.created()[0]!["argv"]).toEqual(
        host
          ? attachmentSshArgv(host, ["agentvoice", ...args], true)
          : ["bun", "/checkout/main.ts", ...args],
      );
      const header = JSON.stringify({
        type: "voice_transcript",
        format: "agentvoice",
        workspace: attachedIdentity.workspace,
        threadId: attachedIdentity.threadId,
      });
      await composition.receive({ v: 1, type: "voice", line: header });
      const viewer = mux.created()[1]!["argv"] as string[];
      expect(viewer[0]).toBe("codex-viewer");
      transcript = viewer[2]!;
      expect(readFileSync(transcript, "utf8")).toBe(`${header}\n`);
      expect(mux.created().map((app) => app["name"])).toEqual(["agent", "voice"]);
      expect(mux.created().every((app) => app["pty"] === "local")).toBe(true);
      await composition.receive(session);
      expect(mux.created()).toHaveLength(2);
      expect(mux.layout.focus).toBe("agent");
      await expect(
        composition.receive({ ...session, identity: { ...attachedIdentity, generation: 2 } }),
      ).rejects.toThrow("Backend changed");
      composition.event({
        type: "event",
        event: "app.state",
        data: { app: { name: "agent", state: "exited" } },
      });
      await composition.done;
      await composition.receive(session);
      expect(mux.created()).toHaveLength(2);
    } finally {
      composition.stop();
      await composition.drained();
    }
    expect(existsSync(transcript!)).toBe(false);
  },
);

test("view refuses audio flags and SSH outside the desktop attachment mode", async () => {
  for (const args of [
    ["--host", "smolbird"],
    ["client", "--attach"],
    ["client", "--host", "smolbird"],
    ["--attach", "--device", "0"],
    ["--attach", "--connect", "private.json"],
    ["--attach", "--host", "-oProxyCommand=bad"],
    ["--attach", "--host", "smolbird", "--workspace", "relative"],
  ])
    expect(await main(args)).toBe(2);
});
