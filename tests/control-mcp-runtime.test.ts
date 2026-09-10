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
const tools = Object.fromEntries(CONTROL_MCP_TOOLS.map((name) => [name, { name }]));

test("default readiness accepts a catalog arriving after five seconds without another request", async () => {
  let calls = 0;
  await requireControlMcpReady(
    <T>(_method: string, _params: unknown, timeoutMs?: number) => {
      calls++;
      return new Promise<T>((resolve, reject) => {
        const response = setTimeout(() => {
          clearTimeout(deadline);
          resolve({
            data: [
              {
                name: control.name,
                runtimeStatus: "connected",
                authStatus: "bearerToken",
                tools,
              },
            ],
            nextCursor: null,
          } as T);
        }, 5_100);
        const deadline = setTimeout(() => {
          clearTimeout(response);
          reject(new AppServerError("catalog timed out", undefined, true));
        }, timeoutMs);
      });
    },
    "saved",
    control,
  );
  expect(calls).toBe(1);
}, 10_000);

test("catalog RPC timeout uses the remaining deadline and is not retried", async () => {
  const budgets: number[] = [];
  const timeout = new AppServerError("catalog timed out", undefined, true);
  await expect(
    requireControlMcpReady(
      async <T>(_method: string, _params: unknown, timeoutMs?: number) => {
        budgets.push(timeoutMs!);
        if (budgets.length === 1) {
          await Bun.sleep(20);
          return { data: [], nextCursor: "next" } as T;
        }
        return new Promise<T>((_resolve, reject) => setTimeout(() => reject(timeout), timeoutMs));
      },
      "saved",
      control,
      200,
    ),
  ).rejects.toBe(timeout);
  expect(budgets).toHaveLength(2);
  expect(budgets[0]!).toBeLessThanOrEqual(200);
  expect(budgets[1]!).toBeGreaterThan(0);
  expect(budgets[1]!).toBeLessThan(budgets[0]!);
});

describe("mandatory control registration", () => {
  test("start/resume inject independent of role, preserve other servers, and verify each exact thread", async () => {
    for (const resume of [false, true]) {
      const h = runtimeHarness({
        orchestrator: { config: { mcp_servers: { other: { command: "example" } } } },
      });
      if (resume) h.native.main("saved", h.directory);
      h.native.override = (method) =>
        method === "mcpServerStatus/list"
          ? Promise.resolve({
              data: [
                {
                  name: control.name,
                  runtimeStatus: "connected",
                  authStatus: "bearerToken",
                  tools,
                },
              ],
              nextCursor: null,
            })
          : undefined;
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
        const checks = h.native.calls.filter((call) => call.method === "mcpServerStatus/list");
        expect(checks).toHaveLength(1);
        expect(checks[0]!.params["threadId"]).toBe(resume ? "saved" : "thread-1");
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
  test("catalog gate rejects absent/unknown connection and stale/wrong tools, pages exact thread", async () => {
    for (const runtimeStatus of [undefined, null, "failed", "disabled"]) {
      await expect(
        requireControlMcpReady(
          async <T>() => ({ data: [{ name: control.name, runtimeStatus, tools }] }) as T,
          "saved",
          control,
        ),
      ).rejects.toThrow("required tool catalog");
    }
    await expect(
      requireControlMcpReady(
        async <T>() =>
          ({
            data: [
              {
                name: control.name,
                runtimeStatus: "connected",
                authStatus: "bearerToken",
                tools: { ...tools, unexpected: {} },
              },
            ],
          }) as T,
        "saved",
        control,
      ),
    ).rejects.toThrow();
    const calls: unknown[] = [];
    await requireControlMcpReady(
      async <T>(_method: string, params: unknown) => {
        calls.push(params);
        return (
          calls.length === 1
            ? { data: [], nextCursor: "1" }
            : {
                data: [
                  {
                    name: control.name,
                    runtimeStatus: "connected",
                    authStatus: "bearerToken",
                    tools,
                  },
                ],
                nextCursor: null,
              }
        ) as T;
      },
      "saved",
      control,
    );
    expect(calls).toEqual([
      { threadId: "saved", detail: "toolsAndAuthOnly", limit: 64 },
      { threadId: "saved", detail: "toolsAndAuthOnly", limit: 64, cursor: "1" },
    ]);
  });
  test("readiness failure never emits voice-ready and closes native", async () => {
    const h = runtimeHarness();
    h.native.override = (method) =>
      method === "mcpServerStatus/list"
        ? Promise.resolve({ data: [], nextCursor: null })
        : undefined;
    const runtime = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      controlMcp: control,
      controlReadinessTimeoutMs: 30,
    });
    try {
      await expect(runtime.start()).rejects.toThrow("not ready");
      expect(h.ready).toEqual([]);
      expect(h.native.closes).toBe(1);
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });
  test("catalog RPC timeout or refusal closes native without readiness, media, or retry", async () => {
    for (const error of [
      new AppServerError("catalog timed out", undefined, true),
      new AppServerError("catalog refused", -32603),
    ]) {
      const h = runtimeHarness();
      h.native.override = (method) =>
        method === "mcpServerStatus/list" ? Promise.reject(error) : undefined;
      const runtime = new VoiceRuntime(h.config, "test", h.events, {
        ...h.runtimeOptions,
        controlMcp: control,
      });
      try {
        await expect(runtime.start()).rejects.toBe(error);
        expect(h.ready).toEqual([]);
        expect(h.native.closes).toBe(1);
        expect(
          h.native.calls.filter((call) => call.method === "mcpServerStatus/list"),
        ).toHaveLength(1);
        expect(h.native.calls.some((call) => call.method === "thread/realtime/start")).toBe(false);
      } finally {
        await runtime.shutdown();
        await h.cleanup();
      }
    }
  });
});

test("readiness is bounded, polls transient initialization, and rejects wrong auth or duplicate pages", async () => {
  let calls = 0;
  const connected = {
    name: control.name,
    runtimeStatus: "connected",
    authStatus: "bearerToken",
    tools,
  };
  await requireControlMcpReady(
    async <T>() =>
      ({
        data: [++calls === 1 ? { ...connected, runtimeStatus: "starting" } : connected],
        nextCursor: null,
      }) as T,
    "saved",
    control,
    200,
  );
  expect(calls).toBe(2);
  await expect(
    requireControlMcpReady(
      async <T>() =>
        ({ data: [{ ...connected, authStatus: "unsupported" }], nextCursor: null }) as T,
      "saved",
      control,
      50,
    ),
  ).rejects.toThrow("authenticated");
  calls = 0;
  await expect(
    requireControlMcpReady(
      async <T>() => ({ data: [connected], nextCursor: ++calls === 1 ? "next" : null }) as T,
      "saved",
      control,
      100,
    ),
  ).rejects.toThrow("duplicate");
  const began = Date.now();
  await expect(
    requireControlMcpReady(
      async <T>() =>
        ({ data: [{ ...connected, runtimeStatus: "notStarted" }], nextCursor: null }) as T,
      "saved",
      control,
      30,
    ),
  ).rejects.toThrow("not ready");
  expect(Date.now() - began).toBeLessThan(150);
});
