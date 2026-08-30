import { describe, expect, test } from "bun:test";
import { EventJournal } from "../src/events.ts";

describe("EventJournal", () => {
  test("an event that arrived before the wait satisfies its occurrence", async () => {
    const journal = new EventJournal();
    journal.record("realtime", "output.transcript.done", { text: "one" });
    journal.record("realtime", "output.transcript.done", { text: "two" });

    const event = await journal.waitFor("output.transcript.done", 2, 10);
    expect(event.data["text"]).toBe("two");
  });

  test("waits for a future occurrence", async () => {
    const journal = new EventJournal();
    const waiting = journal.waitFor("delegation.created", 1, 100);
    journal.record("realtime", "delegation.created", { id: "d1" });
    expect((await waiting).data["id"]).toBe("d1");
  });

  test("waits for the first matching event after an anchor", async () => {
    const journal = new EventJournal();
    journal.record("realtime", "output.transcript.done", { text: "ack" });
    const anchor = journal.record("app-server", "orchestrator.turn.completed");
    const waiting = journal.waitForNext("output.transcript.done", anchor.seq, 100);
    journal.record("realtime", "output.transcript.done", { text: "result" });
    expect((await waiting).data["text"]).toBe("result");
  });
});
