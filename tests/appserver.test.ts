import { describe, expect, test } from "bun:test";
import {
  buildDenialResponse,
  frameNotification,
  frameRequest,
  frameResponse,
  parseFrames,
  spawnArgv,
} from "../src/server/appserver.ts";

describe("parseFrames", () => {
  test("parses complete lines and keeps the partial tail", () => {
    const { frames, rest } = parseFrames('{"a":1}\n{"b":2}\n{"partial"');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"partial"');
  });

  test("drops non-JSON lines instead of failing", () => {
    const { frames, rest } = parseFrames('not json\n{"ok":true}\n');
    expect(frames).toEqual([{ ok: true }]);
    expect(rest).toBe("");
  });

  test("handles empty input and blank/CRLF lines", () => {
    expect(parseFrames("")).toEqual({ frames: [], rest: "" });
    const { frames } = parseFrames('\n\r\n{"x":1}\r\n');
    expect(frames).toEqual([{ x: 1 }]);
  });
});

describe("framing", () => {
  test("request frames are newline-terminated JSON-RPC 2.0", () => {
    const frame = frameRequest(7, "thread/start", { cwd: "/tmp" });
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "thread/start",
      params: { cwd: "/tmp" },
    });
  });

  test("notification frames carry no id", () => {
    const frame = JSON.parse(frameNotification("initialized", {}));
    expect(frame).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
  });

  test("response frames answer by id", () => {
    const frame = JSON.parse(frameResponse(3, { decision: "decline" }));
    expect(frame).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { decision: "decline" },
    });
  });
});

describe("buildDenialResponse", () => {
  test("denies command approvals in the shape app-server expects", () => {
    expect(buildDenialResponse("item/commandExecution/requestApproval")).toEqual({
      decision: "decline",
    });
    expect(buildDenialResponse("execCommandApproval")).toHaveProperty("decision.denied");
    expect(buildDenialResponse("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(buildDenialResponse("tool/requestUserInput")).toEqual({ answers: {} });
  });

  test("answers unknown methods with an empty object so turns never park", () => {
    expect(buildDenialResponse("some/future/request")).toEqual({});
  });
});

describe("spawnArgv", () => {
  test("enables the realtime feature and pins stdio transport", () => {
    expect(spawnArgv("/usr/local/bin/codex")).toEqual([
      "/usr/local/bin/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "stdio://",
    ]);
  });
});
