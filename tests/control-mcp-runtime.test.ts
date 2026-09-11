import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_MCP_SERVER_NAME, CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { AppServerError } from "../src/core/attach.ts";
import { requireControlMcpReady } from "../src/core/control-mcp.ts";
import { prepareRuntime, VoiceRuntime } from "../src/core/runtime.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const control = {
  name: CONTROL_MCP_SERVER_NAME,
  server: { url: "http://127.0.0.1:1/mcp", required: true },
  tools: CONTROL_MCP_TOOLS,
  env: { PRIVATE_TEST_CAPABILITY: "fixture-secret" },
};
const readyResponse = () => ({
  content: [],
  structuredContent: {
    protocolVersion: 5,
    instanceId: "test-controller",
    workspace: "",
    threadId: "",
    generation: 0,
    runtime: { phase: "starting" },
    recentOperations: [],
  },
});

test("readiness probes only the controller-bound tool instead of the global MCP catalog", async () => {
  const calls: Array<{ method: string; params: unknown; timeout?: number }> = [];
  await requireControlMcpReady(
    async <T>(method: string, params: unknown, timeout?: number) => {
      calls.push({ method, params, timeout });
      return readyResponse() as T;
    },
    "saved",
    control,
  );
  expect(calls).toEqual([
    {
      method: "mcpServer/tool/call",
      params: {
        threadId: "saved",
        server: control.name,
        tool: "agentvoice_status",
        arguments: {},
      },
      timeout: 10_000,
    },
  ]);
});

test("direct readiness timeout is bounded and is not retried", async () => {
  let calls = 0;
  const timeout = new AppServerError("control timed out", undefined, true);
  await expect(
    requireControlMcpReady(
      async <_T>(_method: string, _params: unknown, timeoutMs?: number) => {
        calls++;
        expect(timeoutMs).toBe(200);
        throw timeout;
      },
      "saved",
      control,
      200,
    ),
  ).rejects.toBe(timeout);
  expect(calls).toBe(1);
});

describe("mandatory control registration", () => {
  test("start/resume inject independent of role, preserve other servers, and verify each exact thread", async () => {
    for (const resume of [false, true]) {
      const h = runtimeHarness({
        orchestrator: { config: { mcp_servers: { other: { command: "example" } } } },
      });
      if (resume) h.native.main("saved", h.directory);
      h.native.override = (method) =>
        method === "mcpServer/tool/call" ? Promise.resolve(readyResponse()) : undefined;
      const runtime = new VoiceRuntime(h.config, "test", h.events, {
        ...h.runtimeOptions,
        controlMcp: control,
        resume: resume ? "saved" : undefined,
      });
      try {
        await runtime.start();

        const starts = h.native.calls.filter(
          (call) => call.method === "thread/start" || call.method === "thread/resume",
        );
        expect(starts).toHaveLength(1);
        for (const call of starts)
          expect(call.params["config"]).toMatchObject({
            mcp_servers: { [control.name]: control.server, other: { command: "example" } },
          });
        const checks = h.native.calls.filter((call) => call.method === "mcpServer/tool/call");
        expect(checks).toHaveLength(1);
        expect(checks[0]!.params).toEqual({
          threadId: resume ? "saved" : "thread-1",
          server: control.name,
          tool: "agentvoice_status",
          arguments: {},
        });
        expect(h.native.options.env?.["PRIVATE_TEST_CAPABILITY"]).toBe("fixture-secret");
      } finally {
        await runtime.shutdown();
        await h.cleanup();
      }
    }
  });
  test("reserved collisions fail preflight including entries hidden behind raw config", async () => {
    for (const extra of [undefined, { config: {} }]) {
      const h = runtimeHarness({
        orchestrator: {
          config: { mcp_servers: { [control.name]: { command: "forbidden" } } },
          extra,
        },
      });
      try {
        await expect(prepareRuntime(h.config, control)).rejects.toThrow("reserved");
        expect(h.native.calls).toHaveLength(0);
      } finally {
        await h.cleanup();
      }
    }
  });
  test("snapshot pins prompts through activation; exact restart resume never invokes inventory", async () => {
    const h = runtimeHarness();
    h.native.main("saved", h.directory);
    const path = join(h.directory, "VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md");
    writeFileSync(path, "preflight content");
    const snapshot = await prepareRuntime(h.config);
    writeFileSync(path, "later content");
    const runtime = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      snapshot,
      exactResume: "saved",
    });
    try {
      await runtime.start();
      expect(h.native.calls.some((call) => call.method === "thread/list")).toBe(false);
      expect(
        h.native.calls.find((call) => call.method === "thread/resume")!.params[
          "developerInstructions"
        ],
      ).toBe("preflight content");
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });
  test("readiness rejects failed or malformed controller-bound status results", async () => {
    for (const response of [
      {},
      { isError: true, structuredContent: readyResponse().structuredContent },
      { structuredContent: null },
      { structuredContent: { ...readyResponse().structuredContent, protocolVersion: null } },
      { structuredContent: { ...readyResponse().structuredContent, instanceId: "" } },
      { structuredContent: { ...readyResponse().structuredContent, runtime: null } },
      { structuredContent: { ...readyResponse().structuredContent, recentOperations: null } },
    ]) {
      await expect(
        requireControlMcpReady(async <T>() => response as T, "saved", control),
      ).rejects.toThrow("invalid authenticated readiness result");
    }
    await expect(
      requireControlMcpReady(async <T>() => readyResponse() as T, "saved", {
        ...control,
        tools: control.tools.filter((tool) => tool !== "agentvoice_status"),
      }),
    ).rejects.toThrow("no readiness tool");
  });
  test("readiness failure never emits voice-ready and closes native", async () => {
    const h = runtimeHarness();
    h.native.override = (method) =>
      method === "mcpServer/tool/call"
        ? Promise.resolve({ isError: true, structuredContent: readyResponse().structuredContent })
        : undefined;
    const runtime = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      controlMcp: control,
      controlReadinessTimeoutMs: 30,
    });
    try {
      await expect(runtime.start()).rejects.toThrow("invalid authenticated readiness result");
      expect(h.ready).toEqual([]);
      expect(h.native.closes).toBe(1);
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });
  test("direct readiness timeout or refusal closes native without readiness, media, or retry", async () => {
    for (const error of [
      new AppServerError("control timed out", undefined, true),
      new AppServerError("control refused", -32603),
    ]) {
      const h = runtimeHarness();
      h.native.override = (method) =>
        method === "mcpServer/tool/call" ? Promise.reject(error) : undefined;
      const runtime = new VoiceRuntime(h.config, "test", h.events, {
        ...h.runtimeOptions,
        controlMcp: control,
      });
      try {
        await expect(runtime.start()).rejects.toBe(error);
        expect(h.ready).toEqual([]);
        expect(h.native.closes).toBe(1);
        expect(h.native.calls.filter((call) => call.method === "mcpServer/tool/call")).toHaveLength(
          1,
        );
        expect(h.native.calls.some((call) => call.method === "thread/realtime/start")).toBe(false);
      } finally {
        await runtime.shutdown();
        await h.cleanup();
      }
    }
  });
});
