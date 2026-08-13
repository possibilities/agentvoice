import { describe, expect, test } from "bun:test";
import type { RawFrameEvent } from "../src/chats/model.ts";
import { type TranscriptConnection, TranscriptSource } from "../src/chats/transcript-source.ts";

function frame(sequence: number, method: string, params: Record<string, unknown>): RawFrameEvent {
  return {
    kind: "thread",
    sequence,
    receivedAt: sequence,
    direction: "fromAppServer",
    owner: "appServer",
    threadId: "thread-a",
    payload: { method, params },
  };
}

describe("Codex transcript source", () => {
  test("hydrates full history with a non-loading thread/read", async () => {
    const calls: Array<[string, unknown]> = [];
    const connection = {
      async request(method: string, params: unknown) {
        calls.push([method, params]);
        return {
          thread: {
            id: "thread-a",
            turns: [
              {
                id: "turn-a",
                status: "completed",
                items: [{ type: "agentMessage", id: "agent-a", text: "Done" }],
              },
            ],
          },
        };
      },
    } satisfies TranscriptConnection;
    const source = new TranscriptSource(connection);

    const transcript = await source.hydrate("thread-a");

    expect(calls).toEqual([["thread/read", { threadId: "thread-a", includeTurns: true }]]);
    expect(calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(transcript.turns[0]?.items[0]).toMatchObject({
      family: "agent",
      text: "Done",
    });
  });

  test("merges owning frames that arrive while history is loading", async () => {
    let resolveRead!: (value: unknown) => void;
    const connection: TranscriptConnection = {
      request() {
        return new Promise<unknown>((resolve) => {
          resolveRead = resolve;
        });
      },
    };
    const source = new TranscriptSource(connection);
    const hydration = source.hydrate("thread-a");

    source.record(
      frame(1, "item/agentMessage/delta", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "agent-a",
        delta: "Live tail",
      }),
    );
    resolveRead({
      thread: {
        id: "thread-a",
        turns: [
          {
            id: "turn-a",
            status: "inProgress",
            items: [{ type: "userMessage", id: "user-a", content: [] }],
          },
        ],
      },
    });

    const transcript = await hydration;
    expect(transcript.turns[0]?.items.map((item) => [item.id, item.text])).toEqual([
      ["user-a", ""],
      ["agent-a", "Live tail"],
    ]);
    expect(source.get("thread-a")).toBe(transcript);
  });

  test("keeps completed history authoritative over stale live starts", async () => {
    const connection: TranscriptConnection = {
      async request() {
        return {
          thread: {
            id: "thread-a",
            turns: [
              {
                id: "turn-a",
                status: "completed",
                items: [
                  {
                    type: "commandExecution",
                    id: "command-a",
                    command: "pwd",
                    status: "completed",
                    aggregatedOutput: "/tmp\n",
                  },
                ],
              },
            ],
          },
        };
      },
    };
    const source = new TranscriptSource(connection);
    source.record(
      frame(1, "item/started", {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "commandExecution",
          id: "command-a",
          command: "pwd",
          status: "inProgress",
          aggregatedOutput: null,
        },
      }),
    );

    const transcript = await source.hydrate("thread-a");
    expect(transcript.turns[0]?.items[0]).toMatchObject({
      status: "completed",
      output: "/tmp\n",
    });
  });

  test("treats an unmaterialized loaded thread as an empty readable transcript", async () => {
    const connection: TranscriptConnection = {
      async request() {
        throw new Error(
          "thread/read: thread thread-a is not materialized yet; includeTurns is unavailable before first user message",
        );
      },
    };
    const source = new TranscriptSource(connection);

    await expect(source.hydrate("thread-a")).resolves.toMatchObject({
      threadId: "thread-a",
      turns: [],
    });
    const cached = source.get("thread-a");
    expect(cached).not.toBeNull();
    await expect(source.hydrate("thread-a")).resolves.toBe(cached!);
  });

  test("does not resurrect a thread removed while history is loading", async () => {
    let resolveRead!: (value: unknown) => void;
    const connection: TranscriptConnection = {
      request() {
        return new Promise<unknown>((resolve) => {
          resolveRead = resolve;
        });
      },
    };
    const source = new TranscriptSource(connection);
    source.retain(["thread-a"]);
    const hydration = source.hydrate("thread-a");

    source.retain([]);
    source.record(
      frame(1, "item/agentMessage/delta", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "agent-a",
        delta: "late",
      }),
    );
    resolveRead({
      thread: {
        id: "thread-a",
        turns: [{ id: "turn-a", status: "completed", items: [] }],
      },
    });

    await hydration;
    expect(source.get("thread-a")).toBeNull();
  });
});
