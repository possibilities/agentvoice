import { expect, test } from "bun:test";
import { buildEventsSchema } from "../scripts/generate-events-schema.ts";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";
import { conversationEventSchemas } from "../src/events/conversation.ts";
import { eventSocketFrameSchema } from "../src/events/schema.ts";

test("events.schema.json matches its generator and exposes every named event type", async () => {
  const schema = await Bun.file(new URL("../events.schema.json", import.meta.url)).json();
  expect(schema).toEqual(buildEventsSchema());
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  const names = [
    "threads.changed",
    "thread.state.changed",
    "runtime.state.changed",
    "voice.item.started",
    "voice.item.transcript.delta",
    "voice.item.completed",
    ...Object.keys(conversationEventSchemas),
  ];
  expect(schema.$defs.events.anyOf.map((entry: { $ref: string }) => entry.$ref)).toEqual(
    names.map((name) => `#/$defs/${name}`),
  );
  for (const name of names) {
    const event = schema.$defs[name].properties.event;
    const discriminator = event.$ref ? schema.$defs[event.$ref.slice("#/$defs/".length)] : event;
    expect(discriminator.const).toBe(name);
    expect(schema.$defs[name].required).toEqual(["v", "type", "event", "data"]);
    expect(schema.$defs[name].description).toContain(
      name.startsWith("conversation.")
        ? "Conversation:"
        : name.startsWith("voice.")
          ? "Transient:"
          : "Current state:",
    );
  }
});

test("published contract rejects untyped content and unknown fields while permitting subscription defaults", () => {
  const request = {
    v: EVENT_PROTOCOL_VERSION,
    type: "request",
    id: "sub",
    method: "event.subscribe",
  };
  for (const params of [undefined, null, {}, { events: ["voice.*"] }])
    expect(eventSocketFrameSchema.safeParse({ ...request, params }).success).toBe(true);
  const frame = {
    v: EVENT_PROTOCOL_VERSION,
    type: "event",
    event: "voice.item.transcript.delta",
    data: {
      instanceId: "instance",
      generation: 1,
      sequence: 1,
      threadId: "thread",
      itemId: "native",
      delta: "text",
    },
  };
  expect(eventSocketFrameSchema.safeParse(frame).success).toBe(true);
  const threadFrame = {
    v: EVENT_PROTOCOL_VERSION,
    type: "event",
    event: "thread.state.changed",
    data: {
      instanceId: "instance",
      generation: 1,
      sequence: 2,
      thread: {
        id: "thread",
        parentThreadId: null,
        name: null,
        status: "idle",
        activeFlags: [],
        turn: {
          id: "turn",
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_001,
        },
      },
    },
  };
  expect(eventSocketFrameSchema.safeParse(threadFrame).success).toBe(true);
  expect(
    eventSocketFrameSchema.safeParse({
      ...threadFrame,
      data: {
        ...threadFrame.data,
        thread: {
          ...threadFrame.data.thread,
          turn: { ...threadFrame.data.thread.turn, completedAt: -1 },
        },
      },
    }).success,
  ).toBe(false);
  expect(eventSocketFrameSchema.safeParse({ ...frame, type: undefined }).success).toBe(false);
  expect(
    eventSocketFrameSchema.safeParse({
      ...frame,
      data: { ...frame.data, realtimeSessionId: "inferred" },
    }).success,
  ).toBe(false);
  expect(eventSocketFrameSchema.safeParse({ ...frame, event: "unknown" }).success).toBe(false);
  expect(
    eventSocketFrameSchema.safeParse({
      ...request,
      method: "mailbox.get",
      params: { expectedInstanceId: "instance" },
    }).success,
  ).toBe(false);
  expect(
    eventSocketFrameSchema.safeParse({
      ...frame,
      event: "mailbox.changed",
      data: { ...frame.data, state: {} },
    }).success,
  ).toBe(false);
});
