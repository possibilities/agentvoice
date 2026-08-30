import { describe, expect, test } from "bun:test";
import {
  assertCodexReferenceVersion,
  assertCodexReferenceVoiceModel,
  CODEX_REFERENCE,
} from "../src/reference.ts";

describe("Codex reference contract", () => {
  test("accepts the pinned App-server version", () => {
    expect(() => assertCodexReferenceVersion(CODEX_REFERENCE.codexVersion)).not.toThrow();
  });

  test("fails closed when the App-server version drifts", () => {
    expect(() => assertCodexReferenceVersion("codex-cli 0.152.0")).toThrow(
      "Re-verify the V3 default voice model",
    );
  });

  test("rejects a scenario that mislabels the private model", () => {
    expect(() => assertCodexReferenceVoiceModel("gpt-live-1-boulder-alpha")).toThrow(
      "private model cannot be overridden",
    );
  });
});
