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
    expect(() => assertConsumedWireContract(legacy)).not.toThrow();
    expect(() => assertConsumedWireContract(native)).not.toThrow();
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
});

function loadWireFixture(name: string): WireMessageRecord[] {
  return readFileSync(new URL(`../fixtures/codex-voice-sidecar/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireMessageRecord);
}
