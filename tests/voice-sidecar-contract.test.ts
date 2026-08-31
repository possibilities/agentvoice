import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertConsumedWireContract,
  loadVoiceSidecarWireContract,
  projectConsumedWireContract,
  voiceSidecarWireContractSha256,
  type WireMessageRecord,
} from "../src/voice-sidecar-contract.ts";

describe("voice sidecar consumed wire contract", () => {
  test("normalizes the legacy and native consumed wires to the same projection", () => {
    const fixture = loadVoiceSidecarWireContract();
    const legacy = loadWireFixture("legacy-consumed-wire.ndjson");
    const native = loadWireFixture("native-consumed-wire.ndjson");

    expect(projectConsumedWireContract(legacy)).toEqual(fixture.consumedProjection);
    expect(projectConsumedWireContract(native)).toEqual(fixture.consumedProjection);
    expect(() => assertConsumedWireContract(native)).not.toThrow();
  });

  test("rejects legacy-only server notifications under exact native validation", () => {
    const legacy = loadWireFixture("legacy-consumed-wire.ndjson");

    expect(() => assertConsumedWireContract(legacy)).toThrow(
      "unexpected inbound notification method mcpServer/startupStatus/updated",
    );
  });

  test("exposes the raw fixture digest used by Codpiece gates", () => {
    expect(voiceSidecarWireContractSha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects a model override in the V3 realtime start request", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    const start = native.find(
      (record) =>
        record.direction === "out" && record.message["method"] === "thread/realtime/start",
    );
    (start!.message["params"] as Record<string, unknown>)["model"] = "gpt-live-1-codex";

    expect(() => assertConsumedWireContract(native)).toThrow(
      "thread/realtime/start must omit the model override",
    );
  });

  test("allows optional realtime transcript notifications without changing the projection", () => {
    const fixture = loadVoiceSidecarWireContract();
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(
      12,
      0,
      {
        direction: "in",
        message: { method: "thread/realtime/transcript/delta", params: { text: "hi" } },
      },
      {
        direction: "in",
        message: { method: "thread/realtime/transcript/done", params: { text: "hi" } },
      },
    );

    expect(projectConsumedWireContract(native)).toEqual(fixture.consumedProjection);
    expect(() => assertConsumedWireContract(native)).not.toThrow();
  });

  test("rejects unexpected outbound request methods", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(2, 0, {
      direction: "out",
      message: { id: 99, method: "turn/start", params: {} },
    });

    expect(() => assertConsumedWireContract(native)).toThrow(
      "unexpected outbound request method turn/start",
    );
  });

  test("rejects unexpected outbound notification methods", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(2, 0, {
      direction: "out",
      message: { method: "thread/delete", params: {} },
    });

    expect(() => assertConsumedWireContract(native)).toThrow(
      "unexpected outbound notification method thread/delete",
    );
  });

  test("rejects unexpected inbound notification methods", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(2, 0, {
      direction: "in",
      message: { method: "thread/started", params: {} },
    });

    expect(() => assertConsumedWireContract(native)).toThrow(
      "unexpected inbound notification method thread/started",
    );
  });

  test("rejects unknown inbound response IDs", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(2, 0, {
      direction: "in",
      message: { id: 99, result: {} },
    });

    expect(() => assertConsumedWireContract(native)).toThrow("unknown inbound response id 99");
  });

  test("rejects outbound requests left unanswered at EOF", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.push({
      direction: "out",
      message: { id: 99, method: "thread/delete", params: { threadId: "$thread" } },
    });

    expect(() => assertConsumedWireContract(native)).toThrow(
      "unanswered outbound request id 99 method thread/delete",
    );
  });

  test("rejects malformed response envelopes", () => {
    const missingResultOrError = loadWireFixture("native-consumed-wire.ndjson");
    missingResultOrError[1]!.message = { id: 1 };

    expect(() => assertConsumedWireContract(missingResultOrError)).toThrow(
      "response for id 1 must contain exactly one of result or error",
    );

    const bothResultAndError = loadWireFixture("native-consumed-wire.ndjson");
    bothResultAndError[1]!.message = { id: 1, result: {}, error: { code: -1, message: "bad" } };

    expect(() => assertConsumedWireContract(bothResultAndError)).toThrow(
      "response for id 1 must contain exactly one of result or error",
    );

    const errorResponse = loadWireFixture("native-consumed-wire.ndjson");
    errorResponse[1]!.message = { id: 1, error: { code: -32603, message: "failed" } };

    expect(() => assertConsumedWireContract(errorResponse)).toThrow(
      "response for id 1 unexpectedly returned an error",
    );
  });

  test("rejects server-initiated requests, including id:null + method", () => {
    const native = loadWireFixture("native-consumed-wire.ndjson");
    native.splice(2, 0, {
      direction: "in",
      message: { id: "server-1", method: "thread/realtime/start", params: {} },
    });

    expect(() => assertConsumedWireContract(native)).toThrow("inbound server request");

    const nullId = loadWireFixture("native-consumed-wire.ndjson");
    nullId.splice(2, 0, {
      direction: "in",
      message: { id: null, method: "thread/realtime/start", params: {} },
    });

    expect(() => assertConsumedWireContract(nullId)).toThrow("id:null + method");
  });
});

function loadWireFixture(name: string): WireMessageRecord[] {
  return readFileSync(new URL(`../fixtures/codex-voice-sidecar/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireMessageRecord);
}
