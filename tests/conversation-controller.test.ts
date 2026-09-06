import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { VoiceTuiState } from "../src/console/tui.ts";
import { projectNotification } from "../src/events/conversation.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";

test("history responses cannot cross runtime replacement and old content cannot publish into its successor", async () => {
  const root = mkdtempSync("/tmp/av-observation-");
  const delayed = Promise.withResolvers<unknown>();
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const ready: VoiceTuiState = {
    available: true,
    phase: "live",
    liveForMs: 1,
    mic: { muted: false, effectiveMuted: false, db: -8 },
    speaker: { muted: false, effectiveMuted: false, db: -8 },
    conversation: {
      workspace: root,
      threadId: "main",
      model: null,
      effort: null,
      conversationMode: "continued",
      voiceVersion: null,
      prompts: [],
    },
  };
  const controller = new RuntimeController({
    instanceId: "instance",
    stateDir: root,
    version: "test",
    provenance: { parsed: parseArgs([]), options: { debug: false, fresh: false }, launchCwd: root },
    control: { name: "agentvoice_control", server: {}, tools: [], env: {} },
    lease: () => () => {},
    spawn: (_generation, event, lease) => {
      callbacks.push(event);
      const index = callbacks.length;
      const exited = Promise.withResolvers<void>();
      return {
        pid: 100 + index,
        nativePid: undefined,
        exited: exited.promise,
        notify() {},
        stop: async () => {
          exited.resolve();
          return false;
        },
        request: async <T>(method: string): Promise<T> => {
          if (method === "preflight")
            return { workspace: root, pid: 100 + index, buildId: String(index) } as T;
          if (method === "activate") {
            await lease("main");
            event("state", ready);
          }
          if (method === "conversation.thread.get") return (await delayed.promise) as T;
          return null as T;
        },
      };
    },
  });
  try {
    await controller.start();
    const params = {
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      rootThreadId: "main",
      threadId: "main",
    };
    const pending = controller.readConversation("conversation.thread.get", params);
    const settled = Promise.allSettled([pending]);
    await controller.restart({
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      operationId: "replace",
      scope: "runtime",
    });
    const deadline = Date.now() + 2000;
    while (controller.status().currentOperation?.phase !== "ready" && Date.now() < deadline)
      await Bun.sleep(5);
    expect(controller.status().generation).toBe(2);
    delayed.resolve({
      ok: true,
      result: {
        method: "conversation.thread.get",
        rootThreadId: "main",
        threadId: "main",
        revisionBefore: 0,
        revisionAfter: 0,
        changedDuringRead: false,
        data: { id: "main", cwd: root, status: { type: "idle" } },
        nextCursor: null,
      },
    });
    const [result] = await settled;
    expect(result?.status).toBe("rejected");
    if (result?.status === "rejected") expect(result.reason.code).toBe("stale_generation");
    const notification = projectNotification(
      "item/started",
      {
        threadId: "main",
        turnId: "turn",
        startedAtMs: 1,
        item: { type: "agentMessage", id: "item", text: "old generation" },
      },
      1,
    )!;
    callbacks[0]!("conversation", notification);
    expect(controller.lifecycle.live("main").items).toEqual([]);
    callbacks[1]!("conversation", {
      ...notification,
      data: {
        ...notification.data,
        item: { type: "agentMessage", id: "item", text: "new generation" },
      },
    });
    expect(controller.lifecycle.live("main").items[0]?.item).toMatchObject({
      text: "new generation",
    });
  } finally {
    delayed.resolve(null);
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
