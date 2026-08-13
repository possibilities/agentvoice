import { describe, expect, test } from "bun:test";
import { BoxRenderable, CodeRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import type { ChatsConnection } from "../src/chats/client.ts";
import { ChatsModel, type RawFrameEvent } from "../src/chats/model.ts";
import { runChatsUi } from "../src/chats/ui.ts";

function thread(id: string, name: string, cwd = "/tmp/workspace"): Record<string, unknown> {
  return {
    id,
    name,
    preview: name,
    status: { type: "idle" },
    threadSource: "agentvoice-orchestrator",
    modelProvider: "openai",
    cwd,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("AgentVoice Chats UI", () => {
  test("supports keyboard, mouse, resize, expansion, and incremental raw frames", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const model = new ChatsModel();
    model.replaceThreads([thread("thread-a", "Inspect live traffic", "/Users/arthack/project")]);
    const eventHandler: { current: ((event: RawFrameEvent) => void) | null } = { current: null };
    let closed = false;
    const ui = runChatsUi({
      connection: { close() {} } as ChatsConnection,
      model,
      async refreshThreads() {},
      setEventHandler(handler) {
        eventHandler.current = handler;
      },
      onClosed() {
        closed = true;
      },
      createRenderer: async () => setup.renderer,
    });

    const text = (id: string) => {
      const renderable = setup.renderer.root.findDescendantById(id);
      if (renderable instanceof TextRenderable) {
        return renderable.content.chunks.map((chunk) => chunk.text).join("");
      }
      if (renderable instanceof CodeRenderable) return renderable.content;
      return null;
    };

    await setup.flush();
    expect(text("chats-title")).toContain("AGENTVOICE / CHATS");
    expect(setup.renderer.root.findDescendantById("thread-card-thread-a")).toBeDefined();
    expect(setup.captureCharFrame()).toContain("ORCHESTRATOR");
    expect(setup.captureCharFrame()).not.toContain("Inspect live traffic");

    setup.mockInput.pressEnter();
    await setup.flush();
    expect(text("empty-events")).toContain("Waiting for this thread's next app-server frame");
    expect(text("detail-title")).toBe("Inspect live traffic");
    expect(text("detail-state")).toBe("IDLE");
    expect(text("detail-facts")).toContain("ROLE       orchestrator");
    expect(text("detail-facts")).toContain("WORKSPACE  ~/project");
    expect(text("detail-facts")).not.toContain("thread-a");
    expect(text("detail-facts")).not.toContain("·");

    const first = model.recordEnvelope({
      direction: "fromAppServer",
      owner: "appServer",
      payload: { method: "turn/started", params: { threadId: "thread-a", raw: { a: 1 } } },
    });
    expect(first).not.toBeNull();
    eventHandler.current?.(first!);
    await setup.waitFor(
      () => text(`event-code-${first!.sequence}`)?.includes("turn/started") === true,
    );

    const second = model.recordEnvelope({
      direction: "toAppServer",
      owner: "client",
      payload: { id: 9, method: "thread/read", params: { threadId: "thread-a" } },
    });
    eventHandler.current?.(second!);
    await setup.waitFor(
      () => text(`event-code-${second!.sequence}`)?.includes("thread/read") === true,
    );
    expect(text("chats-status")).toBe("2 EVENTS  FOLLOW");
    const firstBox = setup.renderer.root.findDescendantById(`event-${first!.sequence}`);
    const secondBox = setup.renderer.root.findDescendantById(`event-${second!.sequence}`);
    expect(firstBox).toBeInstanceOf(BoxRenderable);
    expect(secondBox).toBeInstanceOf(BoxRenderable);
    expect((firstBox as BoxRenderable).borderStyle).toBe("single");
    expect((secondBox as BoxRenderable).borderStyle).toBe("heavy");

    setup.mockInput.pressEnter();
    await setup.flush();
    expect(text(`event-code-${second!.sequence}`)).toContain('"threadId": "thread-a"');

    setup.resize(72, 22);
    await setup.flush();
    expect(text("detail-title")).toBe("Inspect live traffic");
    const narrowFrame = setup.captureCharFrame();
    expect(narrowFrame).not.toMatch(/^\s*L\s*$/m);
    expect(narrowFrame.split("\n").filter((row) => row.includes("[")).length).toBe(1);

    const back = setup.renderer.root.findDescendantById("detail-back");
    expect(back).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(back!.x + 1, back!.y, MouseButtons.LEFT);
    await setup.flush();
    await setup.mockMouse.click(10, 5, MouseButtons.LEFT);
    await setup.flush();
    expect(text("detail-title")).toBe("Inspect live traffic");

    const footer = setup.renderer.root.findDescendantById("chats-footer-actions");
    expect(footer).toBeInstanceOf(ScrollBoxRenderable);
    expect((footer as ScrollBoxRenderable).horizontalScrollBar.visible).toBe(false);
    expect((footer as ScrollBoxRenderable).verticalScrollBar.visible).toBe(false);

    const quit = setup.renderer.root.findDescendantById("chats-footer-action-quit");
    expect(quit).toBeInstanceOf(BoxRenderable);
    const quitTarget = quit as BoxRenderable;
    const quitRail = footer as ScrollBoxRenderable;
    quitRail.scrollLeft = Math.max(0, quitRail.scrollWidth - quitRail.width);
    await setup.flush();
    await setup.mockMouse.click(quitTarget.x + 1, quitTarget.y, MouseButtons.LEFT);
    await ui;
    expect(closed).toBe(true);
  });
});
