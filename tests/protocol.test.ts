import { describe, expect, test } from "bun:test";
import { parseServerMessage, type WorkerUpdateMessage } from "../src/protocol.ts";

describe("parseServerMessage", () => {
  test("round-trips a worker update, dropping junk fields", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "worker",
        worker: {
          id: "w1",
          title: "lint sweep",
          status: "completed",
          startedAt: 1_000,
          finishedAt: 13_000,
          report: "fixed 3 files",
          junk: true,
        },
      }),
    ) as WorkerUpdateMessage;
    expect(parsed.type).toBe("worker");
    expect(parsed.worker).toEqual({
      id: "w1",
      title: "lint sweep",
      status: "completed",
      startedAt: 1_000,
      finishedAt: 13_000,
      report: "fixed 3 files",
    });
  });

  test("a running worker carries no finish fields", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "worker",
        worker: { id: "w2", title: "docs", status: "running", startedAt: 5 },
      }),
    ) as WorkerUpdateMessage;
    expect(parsed.worker).toEqual({ id: "w2", title: "docs", status: "running", startedAt: 5 });
  });

  test("stays lenient: malformed workers and unknown types are null", () => {
    expect(parseServerMessage(JSON.stringify({ type: "worker" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "worker", worker: { id: 3 } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "sparkles" }))).toBeNull();
    expect(parseServerMessage("not json")).toBeNull();
  });
});
