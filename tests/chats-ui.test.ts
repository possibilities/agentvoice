import { describe, expect, test } from "bun:test";
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { ChatsModel, type RawStreamEvent } from "../src/chats/model.ts";
import { TranscriptSource } from "../src/chats/transcript-source.ts";
import { previewOutput } from "../src/chats/transcript-ui.ts";
import { runChatsUi } from "../src/chats/ui.ts";

function thread(id: string, name: string, cwd = "/tmp/workspace"): Record<string, unknown> {
  return {
    id,
    name,
    preview: "Conversation text that must never appear on a card",
    status: { type: "idle" },
    threadSource: "agentvoice-orchestrator",
    modelProvider: "openai",
    cwd,
    createdAt: 1,
    updatedAt: 2,
  };
}

const historicalThread = {
  ...thread("thread-a", "Inspect live traffic", "/Users/arthack/project"),
  turns: [
    {
      id: "turn-a",
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
      items: [
        {
          type: "userMessage",
          id: "user-a",
          content: [{ type: "text", text: "Inspect the worker cleanup", text_elements: [] }],
        },
        {
          type: "reasoning",
          id: "reasoning-a",
          summary: ["Tracing ownership"],
          content: ["The registry owns cleanup."],
        },
        {
          type: "commandExecution",
          id: "command-a",
          command: 'rg -n "cleanup" src',
          cwd: "/Users/arthack/project",
          status: "completed",
          aggregatedOutput: "src/workers.ts:40:cleanup\n",
          exitCode: 0,
          durationMs: 18,
        },
        {
          type: "fileChange",
          id: "edit-a",
          status: "completed",
          changes: [
            {
              path: "src/workers.ts",
              kind: "update",
              diff: "--- a/src/workers.ts\n+++ b/src/workers.ts\n@@ -1 +1 @@\n-old\n+new",
            },
          ],
        },
        {
          type: "agentMessage",
          id: "agent-a",
          text: "The cleanup is owned by the worker registry.",
        },
      ],
    },
  ],
};

describe("AgentVoice Chats UI", () => {
  test("bounds collapsed command output by lines and total characters", () => {
    const output = Array.from({ length: 12 }, (_, index) => `${index}:${"x".repeat(1_000)}`).join(
      "\n",
    );

    const preview = previewOutput(output, false);

    expect(preview.length).toBeLessThanOrEqual(2_400);
    expect(preview).toEndWith("… 2 more lines");
    expect(previewOutput(output, true)).toBe(output);
  });

  test("renders compact cards and a touchable Codex Harness while Voice Sessions stay raw", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const model = new ChatsModel();
    model.replaceThreads([thread("thread-a", "Inspect live traffic", "/Users/arthack/project")]);
    const eventHandler: { current: ((event: RawStreamEvent) => void) | null } = { current: null };
    let closed = false;
    const connection = {
      close() {},
      async request() {
        return { thread: historicalThread };
      },
    };
    const transcripts = new TranscriptSource(connection);
    const ui = runChatsUi({
      connection,
      model,
      transcripts,
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
      if (renderable instanceof MarkdownRenderable) return renderable.content;
      return null;
    };

    await setup.flush();
    expect(text("chats-title")).toContain("AGENTVOICE / CHATS");
    expect(setup.renderer.root.findDescendantById("voice-stream-card")).toBeDefined();
    const initialThreadCard = setup.renderer.root.findDescendantById("thread-card-thread-a");
    expect(initialThreadCard).toBeInstanceOf(BoxRenderable);
    expect((initialThreadCard as BoxRenderable).height).toBe(2);
    const listFrame = setup.captureCharFrame();
    expect(listFrame).toContain("Inspect live traffic");
    expect(listFrame).toContain("ORCHESTRATOR");
    expect(listFrame).toContain("~/project");
    expect(listFrame).not.toContain("Conversation text that must never appear");
    expect(listFrame).not.toContain("THREAD thread-a");

    await setup.mockMouse.click(initialThreadCard!.x + 1, initialThreadCard!.y, MouseButtons.LEFT);
    await setup.waitFor(
      () => setup.renderer.root.findDescendantById("harness-item-agent-a") !== undefined,
    );
    expect(text("detail-title")).toBe("Inspect live traffic");
    expect(text("detail-state")).toBe("IDLE");
    expect(text("detail-facts")).toContain("ROLE       orchestrator");
    expect(text("detail-facts")).toContain("WORKSPACE  ~/project");
    expect(text("detail-facts")).not.toContain("thread-a");
    expect(text("harness-label-user-a")).toBe("USER");
    expect(text("harness-label-reasoning-a")).toBe("THINKING");
    expect(text("harness-summary-reasoning-a")).toContain("Tracing ownership");
    expect(text("harness-label-command-a")).toBe("COMMAND");
    expect(text("harness-code-command-a")).toContain('rg -n "cleanup" src');
    expect(text("harness-label-edit-a")).toBe("EDIT");
    expect(setup.renderer.root.findDescendantById("harness-diff-edit-a")).toBeDefined();
    expect(text("harness-label-agent-a")).toBe("AGENT");
    expect(text("harness-markdown-agent-a")).toContain("worker registry");
    expect(text("chats-status")).toBe("5 ITEMS  FOLLOW");
    expect(text("empty-events")).toBeNull();

    const reasoningBox = setup.renderer.root.findDescendantById("harness-item-reasoning-a");
    expect(reasoningBox).toBeInstanceOf(BoxRenderable);
    setup.mockInput.pressArrow("up");
    await setup.flush();
    setup.mockInput.pressArrow("up");
    await setup.flush();
    setup.mockInput.pressArrow("up");
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.waitFor(
      () => text("harness-markdown-reasoning-a")?.includes("registry owns cleanup") === true,
    );

    const rawAction = setup.renderer.root.findDescendantById("chats-footer-action-raw");
    expect(rawAction).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(rawAction!.x + 1, rawAction!.y, MouseButtons.LEFT);
    await setup.flush();
    expect(text("harness-raw-reasoning-a")).toContain('"type": "reasoning"');

    const live = model.recordEnvelope({
      direction: "fromAppServer",
      owner: "appServer",
      payload: {
        method: "item/started",
        params: {
          threadId: "thread-a",
          turnId: "turn-b",
          item: {
            type: "commandExecution",
            id: "command-live",
            command: "pwd",
            status: "inProgress",
          },
        },
      },
    });
    expect(live).not.toBeNull();
    transcripts.record(live!);
    eventHandler.current?.(live!);
    await setup.waitFor(() => text("harness-label-command-live") === "COMMAND");
    expect(text("harness-state-command-live")).toBe("RUNNING");

    const viewAction = setup.renderer.root.findDescendantById("chats-footer-action-view");
    expect(viewAction).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(viewAction!.x + 1, viewAction!.y, MouseButtons.LEFT);
    await setup.waitFor(
      () => text(`thread-event-code-${live!.sequence}`)?.includes("item/started") === true,
    );
    expect(text("chats-status")).toContain("EVENTS");
    expect(text(`thread-event-code-${live!.sequence}`)).toContain('"threadId":"thread-a"');

    setup.resize(72, 22);
    await setup.flush();
    expect(text("detail-title")).toBe("Inspect live traffic");
    const narrowFrame = setup.captureCharFrame();
    expect(narrowFrame).not.toMatch(/^\s*L\s*$/m);
    expect(narrowFrame.split("\n").filter((row) => row.includes("[")).length).toBe(1);

    setup.resize(40, 18);
    await setup.flush();
    const compactFrame = setup.captureCharFrame();
    expect(compactFrame.split("\n").filter((row) => row.includes("[")).length).toBe(1);
    expect(compactFrame).not.toMatch(/^\s*\[(?:PG)?[^\]]*$/m);
    expect(text("detail-facts")).toContain("PROVIDER   openai");
    expect(text("detail-facts")).toContain("WORKSPACE  ~/project");

    const back = setup.renderer.root.findDescendantById("detail-back");
    expect(back).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(back!.x + 1, back!.y, MouseButtons.LEFT);
    await setup.flush();
    const voiceCard = setup.renderer.root.findDescendantById("voice-stream-card");
    expect(voiceCard).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(voiceCard!.x + 1, voiceCard!.y, MouseButtons.LEFT);
    await setup.flush();
    expect(text("detail-title")).toBe("Voice Sessions");
    expect(text("detail-state")).toBe("LIVE");
    expect(text("detail-facts")).toContain("latest 8 sessions");
    expect(text("detail-facts")).toContain("300 / session");
    expect(text("detail-facts")).toContain("AUDIO      excluded; no replay");
    expect(text("empty-events")).toContain("Waiting for a voice-session lifecycle or raw event");
    expect(setup.renderer.root.findDescendantById("chats-footer-action-view")).toBeUndefined();

    const lifecycle = model.recordVoiceObservation({
      kind: "lifecycle",
      voiceSessionId: "voice-session-a",
      threadId: "thread-a",
      state: "active",
      observedAt: 100,
    });
    eventHandler.current?.(lifecycle!);
    await setup.waitFor(
      () =>
        text(`voice-event-code-${lifecycle!.sequence}`)?.includes("active") === true &&
        text("chats-status")?.startsWith("1 EVENT") === true,
    );
    await setup.flush();
    expect(setup.renderer.root.findDescendantById("voice-session-voice-session-a")).toBeDefined();

    const payload = {
      type: "response.done",
      response: { id: "response-1", raw: { untouched: true } },
    };
    const voice = model.recordVoiceObservation({
      kind: "event",
      voiceSessionId: "voice-session-a",
      threadId: "thread-a",
      sequence: 1,
      observedAt: 101,
      payload,
    });
    eventHandler.current?.(voice!);
    await setup.waitFor(
      () => text(`voice-event-code-${voice!.sequence}`)?.includes("response.done") === true,
    );
    expect(voice?.observation.kind).toBe("event");
    if (voice?.observation.kind === "event") expect(voice.observation.payload).toBe(payload);

    const footer = setup.renderer.root.findDescendantById("chats-footer-actions");
    expect(footer).toBeInstanceOf(ScrollBoxRenderable);
    expect((footer as ScrollBoxRenderable).horizontalScrollBar.visible).toBe(false);
    expect((footer as ScrollBoxRenderable).verticalScrollBar.visible).toBe(false);
    const quit = setup.renderer.root.findDescendantById("chats-footer-action-quit");
    expect(quit).toBeInstanceOf(BoxRenderable);
    const quitRail = footer as ScrollBoxRenderable;
    quitRail.scrollLeft = Math.max(0, quitRail.scrollWidth - quitRail.width);
    await setup.flush();
    await setup.mockMouse.click(quit!.x + 1, quit!.y, MouseButtons.LEFT);
    await ui;
    expect(closed).toBe(true);
  });

  test("does not apply a stale history failure to the next thread", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const model = new ChatsModel();
    model.replaceThreads([
      { ...thread("thread-a", "Slow history"), updatedAt: 3 },
      thread("thread-b", "Current history"),
    ]);
    let rejectSlow!: (reason: Error) => void;
    const slow = new Promise<unknown>((_resolve, reject) => {
      rejectSlow = reject;
    });
    const connection = {
      close() {},
      async request(_method: string, params: unknown) {
        const threadId = (params as { threadId: string }).threadId;
        if (threadId === "thread-a") return slow;
        return {
          thread: {
            ...thread("thread-b", "Current history"),
            turns: [
              {
                id: "turn-b",
                status: "completed",
                items: [{ type: "sleep", id: "wait-b", durationMs: 1_000 }],
              },
            ],
          },
        };
      },
    };
    const ui = runChatsUi({
      connection,
      model,
      transcripts: new TranscriptSource(connection),
      async refreshThreads() {},
      setEventHandler() {},
      onClosed() {},
      createRenderer: async () => setup.renderer,
    });
    const text = (id: string) => {
      const renderable = setup.renderer.root.findDescendantById(id);
      return renderable instanceof TextRenderable
        ? renderable.content.chunks.map((chunk) => chunk.text).join("")
        : null;
    };

    await setup.flush();
    const slowCard = setup.renderer.root.findDescendantById("thread-card-thread-a");
    expect(slowCard).toBeInstanceOf(BoxRenderable);
    await setup.mockMouse.click(slowCard!.x + 1, slowCard!.y, MouseButtons.LEFT);
    await setup.waitFor(() => text("chats-status") === "LOADING HISTORY");

    setup.mockInput.pressArrow("left");
    await setup.flush();
    setup.mockInput.pressArrow("down");
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(text("detail-title")).toBe("Current history");
    expect(text("chats-status")).toBe("1 ITEMS  FOLLOW");

    rejectSlow(new Error("late history failure"));
    await Promise.resolve();
    await setup.flush();
    expect(text("detail-title")).toBe("Current history");
    expect(text("chats-status")).not.toContain("FAILED");

    setup.mockInput.pressKey("q");
    await ui;
  });
});
