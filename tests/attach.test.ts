import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AppServerConnection, type AttachOptions, appServerArgv } from "../src/core/attach.ts";
import { OwnedProcessTree } from "../src/core/owned-processes.ts";

const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
async function connect(mode = "", extra: Partial<AttachOptions> = {}) {
  return AppServerConnection.connect({
    argv: [process.execPath, fixture, mode],
    cwd: process.cwd(),
    clientVersion: "test",
    shutdownGraceMs: 50,
    onNotification() {},
    onClose() {},
    ...extra,
  });
}
async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("owned native stdio", () => {
  test("refuses every human-interaction shape visibly, without answers or empty successes", async () => {
    const notices: Record<string, unknown>[] = [];
    const refusals: string[] = [];
    const c = await connect("", {
      onNotification: (method, params) => {
        if (method === "test/response") notices.push(params);
      },
      onRefusal: (message) => refusals.push(message),
    });
    const cases: Array<[string, unknown]> = [
      [
        "execCommandApproval",
        { decision: { denied: { rejection: "agentvoice runs unattended and never approves" } } },
      ],
      [
        "applyPatchApproval",
        { decision: { denied: { rejection: "agentvoice runs unattended and never approves" } } },
      ],
      ["item/commandExecution/requestApproval", { decision: "decline" }],
      ["item/fileChange/requestApproval", { decision: "decline" }],
      ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
      ["mcpServer/elicitation/request", { action: "decline", content: null }],
      ["item/tool/requestUserInput", null],
      ["tool/requestUserInput", null],
      ["item/tool/call", null],
      ["account/chatgptAuthTokens/refresh", null],
      ["future/request", null],
    ];
    try {
      for (const [method, result] of cases) {
        const count = notices.length;
        await c.request("server-request", { method });
        await until(() => notices.length === count + 1);
        const response = notices.at(-1)!;
        if (result === null) {
          expect(response).not.toHaveProperty("result");
          expect(response["error"]).toMatchObject({ code: -32601 });
        } else expect(response["result"]).toEqual(result);
        expect(refusals.at(-1)).toContain(`Refused ${method}`);
      }
      expect(c.alive).toBe(true);
    } finally {
      await c.close();
    }
  });
  test("uses only stock app-server flags", () => {
    expect(appServerArgv("/bin/codex")).toEqual([
      "/bin/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "stdio://",
    ]);
  });
  test("coalesces process snapshots instead of building an unbounded polling queue", async () => {
    const c = await connect();
    const owned = new OwnedProcessTree(c.pid!, { pollIntervalMs: 1 });
    try {
      const snapshots = Array.from({ length: 1_000 }, () => owned.snapshotNow());
      expect(new Set(snapshots).size).toBeLessThanOrEqual(2);
      await Promise.all(snapshots);
    } finally {
      owned.stopTracking();
      await c.close();
    }
  });
  test("round trips large frames and fragmented multibyte UTF-8", async () => {
    const c = await connect();
    try {
      const body = { text: "large 🎤".repeat(20_000) };
      const [echo, fragment] = await Promise.all([
        c.request("echo", body),
        c.request("fragmented", {}),
      ]);
      expect(echo).toEqual(body);
      expect(fragment).toBe("voice 🎤 café");
    } finally {
      await c.close();
    }
  });
  test("delivers native tool/turn notifications unchanged and preserves fail-closed approvals", async () => {
    const notices: Array<[string, Record<string, unknown>]> = [];
    const c = await connect("", {
      onNotification: (m, p) => notices.push([m, p]),
    });
    try {
      await c.request("approval", {});
      const native: Array<[string, Record<string, unknown>]> = [
        ["item/started", { threadId: "main", item: { type: "commandExecution", id: "tool" } }],
        [
          "item/completed",
          { threadId: "main", item: { type: "commandExecution", id: "tool", exitCode: 0 } },
        ],
        ["turn/completed", { threadId: "main", turn: { id: "turn", status: "completed" } }],
      ];
      for (const [method, params] of native) await c.request("notification", { method, params });
      await until(() => notices.some(([m]) => m === "turn/completed"));
      expect(notices).toContainEqual(["test/initialized", {}]);
      expect(notices).toContainEqual(["test/answer", { decision: "decline" }]);
      for (const entry of native) expect(notices).toContainEqual(entry);
    } finally {
      await c.close();
    }
  });

  test("retired worker calls fail promptly and visibly without a callback or replacement work", async () => {
    const responses: Record<string, unknown>[] = [];
    const refusals: string[] = [];
    const c = await connect("", {
      onNotification: (method, params) => {
        if (method === "test/response") responses.push(params);
      },
      onRefusal: (message) => refusals.push(message),
    });
    try {
      for (const tool of ["dispatch_worker", "check_workers", "cancel_worker"]) {
        const count = responses.length;
        await c.request("server-request", {
          method: "item/tool/call",
          params: { threadId: "saved-conversation", tool, arguments: { brief: "must not run" } },
        });
        await until(() => responses.length === count + 1);
        expect(responses.at(-1)).toMatchObject({
          id: "server-request",
          result: { success: false },
        });
        const message = refusals.at(-1)!;
        expect(message).toContain(`Refused ${tool}`);
        expect(message).toContain("retired");
        expect(message).toContain("Fresh or --no-continue");
        expect(responses.at(-1)!["result"]).toEqual({
          success: false,
          contentItems: [{ type: "inputText", text: message }],
        });
      }
      expect(await c.request<{ alive: boolean }>("echo", { alive: true })).toEqual({ alive: true });
    } finally {
      await c.close();
    }
  });
  test("preserves JSON-RPC errors and bounds unanswered requests", async () => {
    const c = await connect();
    try {
      await expect(c.request("fail", {})).rejects.toMatchObject({ code: 42 });
      await expect(c.request("hang", {}, 15)).rejects.toMatchObject({ timedOut: true });
      expect(await c.request<{ still: string }>("echo", { still: "alive" })).toEqual({
        still: "alive",
      });
    } finally {
      await c.close();
    }
  });
  test("crash rejects pending requests and reports closure once", async () => {
    const closed: unknown[] = [];
    const c = await connect("", { onClose: (event) => closed.push(event) });
    await expect(c.request("crash", {})).rejects.toThrow();
    await c.close();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ expected: false });
  });
  test("quit reaps an uncooperative child and is idempotent", async () => {
    const c = await connect("stubborn");
    const pid = c.pid!;
    const pending = c.request("hang", {}).catch((e) => e);
    const start = Date.now();
    await Promise.all([c.close(), c.close()]);
    expect(Date.now() - start).toBeLessThan(3_500);
    expect(c.shutdownForced).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  test("native EOF drain may exceed the former one-second cutoff without forced termination", async () => {
    const c = await connect("delayed-eof", { shutdownGraceMs: undefined });
    const began = Date.now();
    await c.close();
    expect(Date.now() - began).toBeGreaterThanOrEqual(1_100);
    expect(c.shutdownForced).toBe(false);
    expect(() => process.kill(c.pid!, 0)).toThrow();
  });
  test("abort during initialize closes the owned child", async () => {
    const controller = new AbortController();
    const starting = connect("no-initialize", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(starting).rejects.toThrow();
  });
  test("quit also stops tool processes in the owned child's process group", async () => {
    const c = await connect();
    const { pid } = await c.request<{ pid: number }>("descendant", {});
    await c.close();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
  test("forced quit stops an observed detached tool session and its grandchild", async () => {
    const c = await connect("stubborn");
    let owned: { pid: number; grandchildPid: number } | undefined;
    try {
      const result = await c.request<{ pid: number; grandchildPid: number }>(
        "detached-descendants",
        {},
      );
      owned = result;
      expect(isRunning(result.pid)).toBe(true);
      expect(isRunning(result.grandchildPid)).toBe(true);
      await c.close();
      expect(c.shutdownForced).toBe(true);
      expect(c.shutdownCleanup).toMatchObject({ complete: true });
      await until(() => !isRunning(owned!.pid) && !isRunning(owned!.grandchildPid));
    } finally {
      if (owned) {
        try {
          process.kill(-owned.pid, "SIGKILL");
        } catch {}
      }
      await c.close().catch(() => {});
    }
  });
  test("natural native exit cleans an observed detached tool session", async () => {
    const c = await connect();
    let owned: { pid: number; grandchildPid: number } | undefined;
    try {
      owned = await c.request("detached-descendants", {});
      // Let the bounded observer capture the new session before simulating abrupt native loss.
      await Bun.sleep(100);
      await expect(c.request("crash", {})).rejects.toThrow();
      await until(() => !isRunning(owned!.pid) && !isRunning(owned!.grandchildPid), 3_500);
      await c.close();
      expect(c.shutdownCleanup).toMatchObject({ complete: true });
    } finally {
      if (owned) {
        try {
          process.kill(-owned.pid, "SIGKILL");
        } catch {}
      }
      await c.close().catch(() => {});
    }
  });
  test("missing executable fails promptly", async () => {
    await expect(
      connect("", { argv: ["/definitely-not-an-agentvoice-executable"] }),
    ).rejects.toThrow(/could not start Codex/);
  });
  test("malformed stdout fails pending requests instead of hanging", async () => {
    const c = await connect();
    try {
      await expect(c.request("invalid", {})).rejects.toThrow("invalid JSON");
    } finally {
      await c.close();
    }
  });
});
