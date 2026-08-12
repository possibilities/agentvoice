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

  test("notification and response helpers preserve their JSON-RPC shapes", () => {
    expect(JSON.parse(frameNotification("initialized", {}))).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    expect(JSON.parse(frameResponse(3, { decision: "decline" }))).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { decision: "decline" },
    });
  });
});

describe("buildDenialResponse", () => {
  test("denies approval-bearing requests and never leaves an unknown request parked", () => {
    expect(buildDenialResponse("item/commandExecution/requestApproval")).toEqual({
      decision: "decline",
    });
    expect(buildDenialResponse("execCommandApproval")).toHaveProperty("decision.denied");
    expect(buildDenialResponse("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(buildDenialResponse("tool/requestUserInput")).toEqual({ answers: {} });
    expect(buildDenialResponse("some/future/request")).toEqual({});
  });
});

describe("spawnArgv", () => {
  test("uses the private native listener for supervised App-server children", () => {
    expect(spawnArgv("/usr/local/bin/codex", "/state/app-server/control.sock")).toEqual([
      "/usr/local/bin/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "unix:///state/app-server/control.sock",
    ]);
  });

  test("retains stdio for standalone upstream-semantics probes", () => {
    expect(spawnArgv("codex")).toEqual([
      "codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "stdio://",
    ]);
  });
});
