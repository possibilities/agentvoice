import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalImageStore } from "../../src/attachment/local-images.ts";
import { CONTROL_PROTOCOL_VERSION } from "../../src/control/types.ts";
import { type AgentCommand, AgentControls, agentCommandSchema } from "../server/agent-controls.ts";
import { type AgentOperation, AgentSendError } from "../server/agent-sender.ts";

function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "av-web-input-")));
  const target = {
    viewId: randomUUID(),
    instanceId: randomUUID(),
    generation: 1,
    workspace: directory,
    threadId: "main",
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
  };
  const operations: AgentOperation[] = [];
  let outcome: () => Promise<string | undefined> = async () => "accepted-turn";
  const controls = new AgentControls(directory, async (_target, operation, current) => {
    expect(current()).toBe(true);
    operations.push(operation);
    return outcome();
  });
  controls.bind(target);
  controls.observe(undefined, true, 1);
  return {
    directory,
    target,
    operations,
    controls,
    command: (value: object): AgentCommand =>
      agentCommandSchema.parse({ viewId: target.viewId, requestId: randomUUID(), ...value }),
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlQAAAABJRU5ErkJggg==",
  "base64",
);

async function saveImage(workspace: string, threadId: string) {
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

test("send, steer and queue have distinct native semantics; a duplicate request submits once", async () => {
  const h = setup();
  try {
    const send = h.command({ action: "send", text: "First\nmessage" });
    await Promise.all([h.controls.command(send), h.controls.command(send)]);
    expect(h.operations).toMatchObject([{ action: "send", text: "First\nmessage" }]);
    expect(h.operations[0]?.action === "send" && h.operations[0].clientUserMessageId).toBe(
      send.requestId,
    );
    expect(h.controls.view().active).toBe(true);
    h.controls.observe(undefined, true, 1);
    expect(h.controls.view().active).toBe(true);
    await expect(
      h.controls.command(h.command({ action: "send", text: "Wrong mode" })),
    ).rejects.toThrow("Steer or Queue");
    const queued = h.command({ action: "queue", text: "After completion" });
    await h.controls.command(queued);
    expect(h.controls.view().queue[0]?.id).toBe(queued.requestId);
    await h.controls.drain();
    expect(h.operations).toHaveLength(1);
    await h.controls.command(h.command({ action: "steer", text: "Adjust this turn" }));
    expect(h.operations[1]).toMatchObject({
      action: "steer",
      text: "Adjust this turn",
      turnId: "accepted-turn",
    });
    h.controls.observe({ id: "accepted-turn", status: "completed" }, true, 5);
    await h.controls.drain();
    expect(h.operations[2]).toMatchObject({
      action: "send",
      text: "After completion",
      clientUserMessageId: queued.requestId,
    });
    expect(h.controls.view().queue).toEqual([]);
  } finally {
    h.close();
  }
});

test("Stop pauses queued messages, waits for terminal observation, and requires explicit resume", async () => {
  const h = setup();
  try {
    h.controls.observe({ id: "busy", status: "inProgress" }, true, 2);
    await h.controls.command(h.command({ action: "queue", text: "Later" }));
    h.outcome(async () => undefined);
    await h.controls.command(h.command({ action: "interrupt" }));
    expect(h.operations).toMatchObject([{ action: "interrupt", turnId: "busy" }]);
    expect(h.controls.view().stopping).toBe(true);
    h.controls.observe({ id: "busy", status: "interrupted" }, true, 4);
    await h.controls.drain();
    expect(h.operations).toHaveLength(1);
    expect(h.controls.view().stopping).toBe(false);
    const row = h.controls.view().queue[0]!;
    expect(row.pausedReason).toContain("Stopped");
    await h.controls.command(h.command({ action: "resume", id: row.id }));
    h.controls.observe({ id: "busy", status: "interrupted" }, true, 4);
    h.outcome(async () => "next");
    await h.controls.drain();
    expect(h.operations[1]).toMatchObject({ action: "send", text: "Later" });
  } finally {
    h.close();
  }
});

test("queue editing holds the FIFO, preserves position, and can steer a selected row", async () => {
  const h = setup();
  try {
    await h.controls.command(h.command({ action: "queue", text: "First queued" }));
    await h.controls.command(h.command({ action: "queue", text: "Second queued" }));
    const [first, second] = h.controls.view().queue;
    await h.controls.command(h.command({ action: "editing", id: first!.id }));
    await h.controls.drain();
    expect(h.operations).toMatchObject([]);
    await h.controls.command(h.command({ action: "edit", id: first!.id, text: "First edited" }));
    await h.controls.drain();
    expect(h.operations).toMatchObject([]);
    await h.controls.command(h.command({ action: "editing", id: null }));
    expect(h.controls.view().queue.map((row) => row.text)).toEqual([
      "First edited",
      "Second queued",
    ]);
    h.controls.observe({ id: "busy", status: "inProgress" }, true, 2);
    await h.controls.command(h.command({ action: "steerQueued", id: second!.id }));
    expect(h.operations).toMatchObject([
      { action: "steer", turnId: "busy", text: "Second queued" },
    ]);
    expect(h.controls.view().queue.map((row) => row.id)).toEqual([first!.id]);
    await h.controls.command(h.command({ action: "remove", id: first!.id }));
    expect(h.controls.view().queue).toEqual([]);
  } finally {
    h.close();
  }
});

test("repeated steering does not fence out the next terminal event", async () => {
  const h = setup();
  try {
    h.controls.observe({ id: "busy", status: "inProgress" }, true, 2);
    h.outcome(async () => "busy");
    for (let n = 0; n < 4; n++)
      await h.controls.command(h.command({ action: "steer", text: `Update ${n}` }));
    h.controls.observe({ id: "busy", status: "completed" }, true, 3);
    expect(h.controls.view().active).toBe(false);
  } finally {
    h.close();
  }
});

test("late acceptance cannot activate a replacement call", async () => {
  const h = setup();
  try {
    let accept!: (turn: string) => void;
    h.outcome(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const send = h.controls.command(h.command({ action: "send", text: "Old call" }));
    h.controls.bind({ ...h.target, viewId: randomUUID(), generation: 2 });
    h.controls.observe(undefined, true, 1);
    accept("old-turn");
    await send;
    expect(h.controls.view().active).toBe(false);
    expect(h.controls.view().pending).toBe(false);
  } finally {
    h.close();
  }
});

test("lost acceptance pauses delivery permanently and survives a web-server restart without replay", async () => {
  const h = setup();
  try {
    await h.controls.command(h.command({ action: "queue", text: "Possibly sent" }));
    h.outcome(async () => {
      throw new AgentSendError("Delivery is unknown. Check the transcript.", "unknown");
    });
    await h.controls.drain();
    await h.controls.drain();
    expect(h.operations).toHaveLength(1);
    const row = h.controls.view().queue[0]!;
    expect(row.canResume).toBe(false);
    expect(row.canSteer).toBe(false);
    await expect(h.controls.command(h.command({ action: "resume", id: row.id }))).rejects.toThrow(
      "unknown",
    );
    const restarted = new AgentControls(h.directory, async () => {
      throw new Error("Must not replay");
    });
    restarted.bind({ ...h.target, viewId: randomUUID() });
    restarted.observe(undefined, true, 1);
    await restarted.drain();
    expect(restarted.view().queue[0]?.pausedReason).toContain("unknown");
    const path = join(h.directory, "web/queued-messages.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("Possibly sent");
  } finally {
    h.close();
  }
});

test("replacement fences old commands and queues, and definitive failures preserve retryable text", async () => {
  const h = setup();
  try {
    await h.controls.command(h.command({ action: "queue", text: "Original call" }));
    h.controls.bind({ ...h.target, viewId: randomUUID(), generation: 2 });
    h.controls.observe(undefined, true, 1);
    await h.controls.drain();
    expect(h.operations).toMatchObject([]);
    expect(h.controls.view().queue[0]?.pausedReason).toContain("call changed");
    await expect(
      h.controls.command(h.command({ action: "send", text: "Stale browser" })),
    ).rejects.toThrow("call changed");
    h.controls.bind(h.target);
    h.controls.observe(undefined, true, 2);
    const row = h.controls.view().queue[0]!;
    await h.controls.command(h.command({ action: "resume", id: row.id }));
    h.outcome(async () => {
      throw new AgentSendError("Rejected", "rejected");
    });
    await h.controls.drain();
    expect(h.controls.view().queue[0]?.canResume).toBe(true);
    expect(h.controls.view().queue[0]?.text).toBe("Original call");
  } finally {
    h.close();
  }
});

test("Agent requests reject empty/oversized input and arbitrary native parameters", () => {
  const base = { viewId: randomUUID(), requestId: randomUUID(), action: "send" };
  for (const fields of [
    { text: " " },
    { text: " ", images: [] },
    { text: "x".repeat(65537) },
    { text: "ok", images: [{ path: "/tmp/image.png", url: "https://example.test/x" }] },
    { text: "ok", images: Array.from({ length: 5 }, () => ({ path: "/tmp/image.png" })) },
    { text: "ok", threadId: "foreign" },
    { text: "ok", method: "thread/start" },
  ]) {
    expect(agentCommandSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  }
});

test("image input preserves order through send, queue persistence, editing and dispatch", async () => {
  const h = setup();
  try {
    const first = await saveImage(h.target.workspace, h.target.threadId);
    const second = await saveImage(h.target.workspace, h.target.threadId);
    const images = [{ path: second.path }, { path: first.path }];
    const send = h.command({ action: "send", text: "", images });
    await h.controls.command(send);
    expect(h.operations[0]).toEqual({
      action: "send",
      text: "",
      images,
      clientUserMessageId: send.requestId,
    });

    h.controls.observe({ id: "accepted-turn", status: "completed" }, true, 2);
    const queued = h.command({ action: "queue", text: "Queued image", images });
    await Promise.all([h.controls.command(queued), h.controls.command(queued)]);
    expect(h.controls.view().queue).toHaveLength(1);
    expect(h.controls.view().queue[0]?.images).toEqual(images);
    expect(new AgentControls(h.directory).view().queue[0]?.images).toEqual(images);

    await h.controls.command(
      h.command({ action: "edit", id: queued.requestId, text: "Text only after edit" }),
    );
    expect(h.controls.view().queue[0]?.images).toBeUndefined();
    await h.controls.drain();
    expect(h.operations[1]).toMatchObject({
      action: "send",
      text: "Text only after edit",
      clientUserMessageId: expect.any(String),
    });
    expect(h.operations[1]).not.toHaveProperty("images");
  } finally {
    h.close();
  }
});

test("image admission and queued dispatch reject arbitrary, foreign and replaced paths", async () => {
  const h = setup();
  try {
    const valid = await saveImage(h.target.workspace, h.target.threadId);
    const foreign = await saveImage(h.target.workspace, "foreign-thread");
    for (const path of [join(h.directory, "arbitrary.png"), foreign.path])
      await expect(
        h.controls.command(h.command({ action: "queue", text: "Private", images: [{ path }] })),
      ).rejects.toThrow("attached image is unavailable");
    expect(h.controls.view().queue).toEqual([]);

    const symlink = await saveImage(h.target.workspace, h.target.threadId);
    unlinkSync(symlink.path);
    symlinkSync(valid.path, symlink.path);
    await expect(
      h.controls.command(
        h.command({ action: "send", text: "Symlink", images: [{ path: symlink.path }] }),
      ),
    ).rejects.toThrow("attached image is unavailable");
    expect(h.operations).toEqual([]);

    const queued = h.command({
      action: "queue",
      text: "Deleted after admission",
      images: [{ path: valid.path }],
    });
    await h.controls.command(queued);
    unlinkSync(valid.path);
    await h.controls.drain();
    expect(h.operations).toEqual([]);
    expect(h.controls.view().queue[0]).toMatchObject({
      id: queued.requestId,
      canResume: true,
      pausedReason: expect.stringContaining("attached image is unavailable"),
    });
  } finally {
    h.close();
  }
});

test("editing an unknown queue delivery creates a new native identity without moving the row", async () => {
  const h = setup();
  try {
    const queued = h.command({ action: "queue", text: "Original" });
    await h.controls.command(queued);
    h.outcome(async () => {
      throw new AgentSendError("Unknown", "unknown");
    });
    await h.controls.drain();
    expect(h.controls.view().queue[0]?.id).toBe(queued.requestId);
    const edit = h.command({
      action: "edit",
      id: queued.requestId,
      text: "Corrected after review",
    });
    await h.controls.command(edit);
    const saved = JSON.parse(
      readFileSync(join(h.directory, "web", "queued-messages.json"), "utf8"),
    );
    expect(saved[0].clientUserMessageId).toBe(edit.requestId);
    h.outcome(async () => "next-turn");
    await h.controls.drain();
    expect(h.operations[0]).toMatchObject({ clientUserMessageId: queued.requestId });
    expect(h.operations[1]).toMatchObject({
      clientUserMessageId: edit.requestId,
      text: "Corrected after review",
    });
    expect(h.controls.view().queue).toEqual([]);
  } finally {
    h.close();
  }
});

test("parallel endpoint queues cannot read, retarget or overwrite each other's saved input", async () => {
  const h = setup();
  const testWorkspace = join(h.directory, "test-workspace");
  const testTarget = { ...h.target, workspace: testWorkspace, viewId: randomUUID() };
  const testControls = new AgentControls(h.directory, async () => "test-turn", testWorkspace);
  testControls.bind(testTarget);
  testControls.observe({ id: "busy-test", status: "inProgress" }, true, 1);
  const command = (value: object) =>
    agentCommandSchema.parse({ viewId: testTarget.viewId, requestId: randomUUID(), ...value });
  try {
    h.controls.observe({ id: "busy-prod", status: "inProgress" }, true, 2);
    const production = h.command({ action: "queue", text: "Production only" });
    await h.controls.command(production);
    const productionPath = join(h.directory, "web/queued-messages.json");
    const productionBytes = readFileSync(productionPath, "utf8");
    expect(testControls.view().queue).toEqual([]);
    const testing = command({ action: "queue", text: "Test only" });
    await testControls.command(testing);
    for (const action of ["resume", "remove", "edit"] as const) {
      await expect(
        testControls.command(
          command({
            action,
            id: production.requestId,
            ...(action === "edit" ? { text: "Hijacked" } : {}),
          }),
        ),
      ).rejects.toThrow("no longer available");
    }
    await testControls.command(
      command({ action: "edit", id: testing.requestId, text: "Edited test" }),
    );
    expect(readFileSync(productionPath, "utf8")).toBe(productionBytes);
    const resumedProduction = new AgentControls(h.directory);
    const resumedTest = new AgentControls(h.directory, undefined, testWorkspace);
    expect(resumedProduction.view().queue.map((row) => row.text)).toEqual(["Production only"]);
    expect(resumedTest.view().queue.map((row) => row.text)).toEqual(["Edited test"]);
    expect(resumedTest.view().queue[0]?.pausedReason).toContain("Restored");
    expect(
      new AgentControls(h.directory, undefined, join(h.directory, "another-workspace")).view()
        .queue,
    ).toEqual([]);
    await testControls.command(command({ action: "remove", id: testing.requestId }));
    expect(new AgentControls(h.directory, undefined, testWorkspace).view().queue).toEqual([]);
    expect(readFileSync(productionPath, "utf8")).toBe(productionBytes);
  } finally {
    h.close();
  }
});
