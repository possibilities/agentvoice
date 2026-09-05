import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AppServerConnection, type AttachOptions, appServerArgv } from "../src/core/attach.ts";

const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
async function connect(mode = "", extra: Partial<AttachOptions> = {}) {
  return AppServerConnection.connect({
    argv: [process.execPath, fixture, mode],
    cwd: process.cwd(),
    clientVersion: "test",
    onNotification() {},
    onClose() {},
    ...extra,
  });
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2_000;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
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
  test("delivers notifications, answers tools, and preserves fail-closed approvals", async () => {
    const notices: Array<[string, Record<string, unknown>]> = [];
    const c = await connect("", {
      onNotification: (m, p) => notices.push([m, p]),
      onRequest: (m) => (m === "item/tool/call" ? Promise.resolve({ success: true }) : null),
    });
    try {
      await c.request("approval", {});
      await c.request("dynamic", {});
      await until(() => notices.filter(([m]) => m === "test/answer").length === 2);
      expect(notices).toContainEqual(["test/initialized", {}]);
      expect(notices).toContainEqual(["test/answer", { decision: "decline" }]);
      expect(notices).toContainEqual(["test/answer", { success: true }]);
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
    expect(await pending).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
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
  test("a throwing tool handler denies the request without killing the connection", async () => {
    const notices: unknown[] = [];
    const c = await connect("", {
      onRequest() {
        throw new Error("handler failed");
      },
      onNotification: (m, p) => {
        if (m === "test/answer") notices.push(p);
      },
    });
    try {
      await c.request("approval", {});
      await until(() => notices.length === 1);
      expect(notices[0]).toEqual({ decision: "decline" });
      expect(c.alive).toBe(true);
    } finally {
      await c.close();
    }
  });
});
