import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpeechArgs, sendSpeech } from "../scripts/voice-speak.ts";
import { AttachmentGateway, type AttachmentTicket } from "../src/attachment/gateway.ts";
import { attachmentArgv } from "../src/attachment/launcher.ts";
import { attachmentNotification, validateAttachmentRequest } from "../src/attachment/policy.ts";
import type { ReadAttachmentThread } from "../src/attachment/scope.ts";
import { AppServerConnection } from "../src/core/attach.ts";
import { resolveNativeExecutable } from "../src/core/native-listener.ts";
import { parseArgs } from "../src/main.ts";

const identity = { threadId: "owned-thread", workspace: realpathSync(process.cwd()) };
const settings = {
  threadId: identity.threadId,
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
};
async function opened(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
function fixture(holdUnsubscribe = false, rejectSpeech = false, readThread?: ReadAttachmentThread) {
  const threads = new Map<string, Record<string, unknown>>([
    [identity.threadId, { id: identity.threadId, cwd: identity.workspace }],
  ]);
  const reads: string[] = [];
  const calls: Record<string, unknown>[] = [];
  const held: Array<() => void> = [];
  const peers = new Set<import("bun").ServerWebSocket<undefined>>();
  const native = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer native-private")
        return new Response("unauthorized", { status: 401 });
      if (!server.upgrade(request, { data: undefined }))
        return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(peer) {
        peers.add(peer);
      },
      close(peer) {
        peers.delete(peer);
      },
      message(peer, text) {
        const frame = JSON.parse(String(text));
        calls.push(frame);
        if (rejectSpeech && frame.method === "thread/realtime/appendSpeech") {
          peer.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32600, message: "conversation is not running" },
            }),
          );
          return;
        }
        if (frame.id !== undefined && frame.method !== undefined) {
          const respond = () =>
            peer.send(
              JSON.stringify({
                id: frame.id,
                result:
                  frame.method === "thread/read" || frame.method === "thread/resume"
                    ? {
                        thread: threads.get(frame.params.threadId),
                        approvalPolicy: "never",
                        sandbox: { type: "dangerFullAccess" },
                      }
                    : frame.method === "thread/loaded/list"
                      ? { data: [...threads.keys()], nextCursor: null }
                      : frame.method === "thread/list"
                        ? { data: [...threads.values()], nextCursor: "next-native-page" }
                        : {},
              }),
            );
          if (holdUnsubscribe && frame.method === "thread/unsubscribe") held.push(respond);
          else respond();
        }
      },
    },
  });
  const gateway = new AttachmentGateway(
    { url: `ws://127.0.0.1:${native.port}`, token: "native-private" },
    "/stock/codex",
    async (threadId) => {
      reads.push(threadId);
      if (readThread) return readThread(threadId, 2_000);
      return { thread: threads.get(threadId) };
    },
  );
  async function client(ticket: AttachmentTicket) {
    const headers = { Authorization: `Bearer ${ticket.token}` };
    const watch = new WebSocket(`${ticket.url}/watch`, { headers });
    await opened(watch);
    const socket = new WebSocket(ticket.url, { headers });
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(String(data))));
    await opened(socket);
    socket.send(
      JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test" } } }),
    );
    await until(() => frames.length === 1);
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    return { socket, watch, frames };
  }
  return {
    gateway,
    threads,
    reads,
    calls,
    peers,
    client,
    release() {
      for (const respond of held.splice(0)) respond();
    },
    close() {
      gateway.close();
      native.stop(true);
    },
  };
}

describe("guarded TUI attachment", () => {
  test("subagent navigation lists verified descendants, resumes without overrides, and returns to root", async () => {
    const f = fixture();
    f.threads.set("child", {
      id: "child",
      cwd: identity.workspace,
      parentThreadId: identity.threadId,
      status: { type: "idle" },
    });
    f.threads.set("grandchild", {
      id: "grandchild",
      cwd: identity.workspace,
      parentThreadId: "child",
    });
    f.threads.set("unrelated", { id: "unrelated", cwd: identity.workspace });
    try {
      const client = await f.client(f.gateway.issue(identity));
      let id = 1;
      const call = async (method: string, params: Record<string, unknown>) => {
        const requestId = ++id;
        client.socket.send(JSON.stringify({ id: requestId, method, params }));
        await until(() => client.frames.some((frame) => frame["id"] === requestId));
        const frame = client.frames.find((frame) => frame["id"] === requestId)!;
        expect(frame["error"]).toBeUndefined();
        return frame["result"] as Record<string, unknown>;
      };
      expect((await call("thread/loaded/list", {}))["data"]).toEqual([
        identity.threadId,
        "child",
        "grandchild",
      ]);
      const list = await call("thread/list", {
        cwd: identity.workspace,
        ancestorThreadId: identity.threadId,
        sortDirection: "desc",
        useStateDbOnly: true,
        sourceKinds: ["subAgentThreadSpawn"],
        limit: 100,
      });
      expect(list["nextCursor"]).toBe("next-native-page");
      expect((list["data"] as { id: string }[]).map((row) => row.id)).toEqual([
        identity.threadId,
        "child",
        "grandchild",
      ]);
      for (const threadId of [identity.threadId, "child", "grandchild", identity.threadId]) {
        await call("thread/read", { threadId, includeTurns: false });
        await call("thread/resume", {
          threadId,
          model: "local-default",
          approvalPolicy: "never",
          excludeTurns: true,
        });
        expect(
          f.calls.filter((frame) => frame["method"] === "thread/resume").at(-1)?.["params"],
        ).toEqual({ threadId, excludeTurns: true });
        await call("thread/turns/list", { threadId, limit: 1 });
      }
      await call("turn/start", { threadId: "child", input: [{ type: "text", text: "Follow up" }] });
      await call("thread/settings/update", { threadId: "child", approvalPolicy: "on-request" });
      for (const threadId of ["grandchild", "child", identity.threadId])
        await call("thread/unsubscribe", { threadId });
      const closed = new Promise<number>((resolve) =>
        client.watch.addEventListener("close", (event) => resolve(event.code), { once: true }),
      );
      client.socket.terminate();
      expect(await closed).toBe(1000);
    } finally {
      f.close();
    }
  });
  test("discovers descendant notifications and questions before lookup, preserving resolution order", async () => {
    const f = fixture();
    f.threads.set("child", {
      id: "child",
      cwd: identity.workspace,
      parentThreadId: identity.threadId,
    });
    try {
      const client = await f.client(f.gateway.issue(identity));
      const frames = [
        { method: "thread/started", params: { thread: f.threads.get("child") } },
        { method: "item/agentMessage/delta", params: { threadId: "child", delta: "hello" } },
        {
          id: "child-question",
          method: "item/tool/requestUserInput",
          params: { threadId: "child" },
        },
      ];
      for (const frame of frames) for (const peer of f.peers) peer.send(JSON.stringify(frame));
      await until(() => client.frames.length === 4);
      expect(client.frames.slice(1)).toEqual(frames);
      client.socket.send(JSON.stringify({ id: "child-question", result: { answers: {} } }));
      await until(() => f.calls.some((frame) => frame["id"] === "child-question"));
      for (const peer of f.peers) {
        peer.send(
          JSON.stringify({
            id: "resolved-child",
            method: "item/permissions/requestApproval",
            params: { threadId: "child" },
          }),
        );
        peer.send(
          JSON.stringify({
            method: "serverRequest/resolved",
            params: { threadId: "child", requestId: "resolved-child" },
          }),
        );
        peer.send(
          JSON.stringify({ method: "thread/realtime/started", params: { threadId: "child" } }),
        );
        peer.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { threadId: "unrelated", delta: "unrelated-thread-private-message" },
          }),
        );
      }
      await until(() =>
        client.frames.some((frame) => frame["method"] === "serverRequest/resolved"),
      );
      client.socket.send(JSON.stringify({ id: "resolved-child", result: { decision: "accept" } }));
      client.socket.send(
        JSON.stringify({ id: 8, method: "thread/read", params: { threadId: identity.threadId } }),
      );
      await until(() => client.frames.some((frame) => frame["id"] === 8));
      expect(f.calls.some((frame) => frame["id"] === "resolved-child")).toBe(false);
      expect(client.frames.some((frame) => frame["method"] === "thread/realtime/started")).toBe(
        false,
      );
      expect(JSON.stringify(client.frames)).not.toContain("unrelated-thread-private-message");
    } finally {
      f.close();
    }
  });
  test("rejects unrelated mutations and descendant realtime before native dispatch", async () => {
    const f = fixture();
    f.threads.set("child", {
      id: "child",
      cwd: identity.workspace,
      parentThreadId: identity.threadId,
    });
    f.threads.set("unrelated", { id: "unrelated", cwd: identity.workspace });
    try {
      const client = await f.client(f.gateway.issue(identity));
      for (const [index, [method, params]] of [
        ["thread/read", { threadId: "unrelated", includeTurns: true }],
        ["thread/resume", { threadId: "unrelated" }],
        ["thread/list", { ancestorThreadId: "unrelated" }],
        ["turn/start", { threadId: "unrelated", input: [{ type: "text", text: "no" }] }],
        ["thread/realtime/appendSpeech", { threadId: "child", text: "no" }],
        ["thread/archive", { threadId: "child" }],
      ].entries()) {
        const id = index + 2;
        client.socket.send(JSON.stringify({ id, method, params }));
        await until(() => client.frames.some((frame) => frame["id"] === id));
        expect(client.frames.find((frame) => frame["id"] === id)?.["error"]).toBeDefined();
      }
      expect(
        f.calls.every((frame) => ["initialize", "initialized"].includes(frame["method"] as string)),
      ).toBe(true);
      expect(f.reads).not.toContain("child");
    } finally {
      f.close();
    }
  });
  test("revocation fences queued requests and notifications awaiting descendant admission", async () => {
    const read = Promise.withResolvers<unknown>();
    const f = fixture(false, false, () => read.promise);
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "child" } }),
      );
      for (const peer of f.peers)
        peer.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { threadId: "child", delta: "stale" },
          }),
        );
      await until(() => f.reads.length > 0);
      f.gateway.revoke();
      read.resolve({
        thread: { id: "child", cwd: identity.workspace, parentThreadId: identity.threadId },
      });
      await until(() => client.socket.readyState === WebSocket.CLOSED);
      expect(f.calls.some((frame) => frame["method"] === "thread/resume")).toBe(false);
      expect(JSON.stringify(client.frames)).not.toContain("stale");
    } finally {
      read.resolve({});
      f.close();
    }
  });
  test("resolves a relative executable against the voice workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "av-executable-"));
    try {
      symlinkSync(process.execPath, join(root, "codex"));
      expect(resolveNativeExecutable("./codex", root)).toBe(realpathSync(process.execPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("failed native initialization closes the owned child and removes private token state", async () => {
    const root = mkdtempSync(join(tmpdir(), "av-native-failure-"));
    const native = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (!server.upgrade(request, { data: undefined }))
          return new Response("upgrade", { status: 400 });
      },
      websocket: {
        message(peer, data) {
          const frame = JSON.parse(String(data));
          peer.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32600, message: "initialize refused" },
            }),
          );
        },
      },
    });
    try {
      await expect(
        AppServerConnection.connect({
          argv: [
            process.execPath,
            "-e",
            `console.log("listening on: ws://127.0.0.1:${native.port}"); setInterval(() => {}, 1000);`,
            "--",
            "--listen",
            "ws://127.0.0.1:0",
          ],
          cwd: root,
          clientVersion: "test",
          nativeStateDir: root,
          shutdownGraceMs: 50,
          onNotification() {},
          onClose() {},
        }),
      ).rejects.toThrow("initialize refused");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      native.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("attachment has no enable flags or permission overrides", () => {
    for (const flag of ["--allow-tui-attach", "--no-tui-attach"])
      expect(() => parseArgs([flag])).toThrow();
    const argv = attachmentArgv({
      ...identity,
      token: "private",
      url: "ws://127.0.0.1:42",
      codex: "/stock/codex",
    });
    expect(argv).not.toContain("private");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe(identity.threadId);
  });
  test("allows native permission settings while rejecting identity and workspace changes", () => {
    expect(() =>
      validateAttachmentRequest("thread/settings/update", settings, identity),
    ).not.toThrow();
    for (const params of [
      { ...settings, approvalPolicy: "on-request" },
      { ...settings, sandboxPolicy: { type: "readOnly" } },
      { ...settings, permissions: ":workspace" },
    ])
      expect(() =>
        validateAttachmentRequest("thread/settings/update", params, identity),
      ).not.toThrow();
    for (const params of [
      { ...settings, threadId: "other" },
      { ...settings, cwd: "/" },
      { ...settings, config: { approval_policy: "on-request" } },
      { ...settings, environments: [{ id: "remote" }] },
    ])
      expect(() => validateAttachmentRequest("thread/settings/update", params, identity)).toThrow();
    for (const method of [
      "thread/start",
      "thread/archive",
      "thread/fork",
      "thread/rollback",
      "thread/realtime/stop",
      "config/value/write",
      "account/logout",
    ])
      expect(() =>
        validateAttachmentRequest(method, { threadId: identity.threadId }, identity),
      ).toThrow();
    expect(() =>
      validateAttachmentRequest(
        "turn/start",
        { ...settings, input: [{ type: "text", text: "steer" }], runtimeWorkspaceRoots: ["/"] },
        identity,
      ),
    ).toThrow();
  });
  test("filters realtime and unrelated thread notifications", () => {
    expect(
      attachmentNotification("item/agentMessage/delta", { threadId: identity.threadId }, identity),
    ).toBe(true);
    expect(attachmentNotification("item/agentMessage/delta", { threadId: "other" }, identity)).toBe(
      false,
    );
    expect(
      attachmentNotification(
        "thread/realtime/transcript/delta",
        { threadId: identity.threadId },
        identity,
      ),
    ).toBe(false);
  });
  test("forwards later owner turns and streaming text unchanged after the TUI resumes", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: identity.threadId } }),
      );
      await until(() => client.frames.length === 2);
      const received: Record<string, unknown>[] = [];
      for (const number of [1, 2]) {
        const turnId = `owner-turn-${number}`;
        const input = {
          type: "userMessage",
          id: `input-${number}`,
          content: [
            { type: "text", text: `<realtime_delegation>request ${number}</realtime_delegation>` },
          ],
        };
        const output = {
          type: "agentMessage",
          id: `reply-${number}`,
          text: `Live reply ${number}.`,
        };
        const notifications = [
          {
            method: "turn/started",
            params: { threadId: identity.threadId, turn: { id: turnId, status: "inProgress" } },
          },
          {
            method: "item/completed",
            params: { threadId: identity.threadId, turnId, item: input },
          },
          {
            method: "item/started",
            params: { threadId: identity.threadId, turnId, item: { ...output, text: "" } },
          },
          {
            method: "item/agentMessage/delta",
            params: { threadId: identity.threadId, turnId, itemId: output.id, delta: output.text },
          },
          {
            method: "item/completed",
            params: { threadId: identity.threadId, turnId, item: output },
          },
          {
            method: "turn/completed",
            params: { threadId: identity.threadId, turn: { id: turnId, status: "completed" } },
          },
        ];
        for (const notification of notifications)
          for (const peer of f.peers) peer.send(JSON.stringify(notification));
        received.push(...notifications);
        await until(() => client.frames.length === 2 + received.length);
        expect(client.frames.slice(2)).toEqual(received);
      }
    } finally {
      f.close();
    }
  });
  test("strips unknown null placeholders on the wire but preserves supported null settings", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({
          id: 2,
          method: "turn/start",
          params: {
            ...settings,
            input: [{ type: "text", text: "hello" }],
            serviceTier: null,
            experimentalUnknownOverride: null,
          },
        }),
      );
      await until(() => client.frames.length === 2);
      const call = f.calls.find((entry) => entry["method"] === "turn/start");
      expect(call?.["params"]).toHaveProperty("serviceTier", null);
      expect(call?.["params"]).not.toHaveProperty("experimentalUnknownOverride");
    } finally {
      f.close();
    }
  });
  test("watcher distinguishes normal TUI exit from an abnormal disconnect", async () => {
    const f = fixture();
    try {
      for (const code of [1000, 4002]) {
        const client = await f.client(f.gateway.issue(identity));
        const closed = new Promise<number>((resolve) => {
          client.watch.addEventListener("close", (event) => resolve(event.code), { once: true });
        });
        client.socket.close(code);
        expect(await closed).toBe(code === 1000 ? 1000 : 4001);
        await until(() => f.peers.size === 0);
      }
    } finally {
      f.close();
    }
  });
  test("acknowledged unsubscribe permits stock TUI exit without a close handshake", async () => {
    const f = fixture();
    try {
      for (const revoke of [false, true]) {
        const client = await f.client(f.gateway.issue(identity));
        client.socket.send(
          JSON.stringify({
            id: 2,
            method: "thread/unsubscribe",
            params: { threadId: identity.threadId },
          }),
        );
        await until(() => client.frames.length === 2);
        const closed = new Promise<number>((resolve) => {
          client.watch.addEventListener("close", (event) => resolve(event.code), { once: true });
        });
        if (revoke) f.gateway.revoke();
        else client.socket.terminate();
        expect(await closed).toBe(revoke ? 4001 : 1000);
        await until(() => f.peers.size === 0);
      }
    } finally {
      f.close();
    }
  });
  test("stock TUI quit unsubscribes only the displayed agent even with other subscriptions", async () => {
    const f = fixture();
    f.threads.set("child", {
      id: "child",
      cwd: identity.workspace,
      parentThreadId: identity.threadId,
    });
    try {
      const client = await f.client(f.gateway.issue(identity));
      for (const [index, [method, threadId]] of [
        ["thread/resume", identity.threadId],
        ["thread/resume", "child"],
        ["thread/unsubscribe", "child"],
      ].entries()) {
        client.socket.send(JSON.stringify({ id: index + 2, method, params: { threadId } }));
        await until(() => client.frames.length === index + 2);
      }
      const closed = new Promise<number>((resolve) =>
        client.watch.addEventListener("close", (event) => resolve(event.code), { once: true }),
      );
      client.socket.terminate();
      expect(await closed).toBe(1000);
    } finally {
      f.close();
    }
  });
  test("late unsubscribe acknowledgment cannot hide a disconnect after a later rejected request", async () => {
    const f = fixture(true);
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({
          id: 2,
          method: "thread/unsubscribe",
          params: { threadId: identity.threadId },
        }),
      );
      await until(() => f.calls.some((call) => call["method"] === "thread/unsubscribe"));
      client.socket.send(JSON.stringify({ id: 3, method: "thread/start", params: {} }));
      await until(() => client.frames.length === 2);
      f.release();
      await until(() => client.frames.length === 3);
      const closed = new Promise<number>((resolve) => {
        client.watch.addEventListener("close", (event) => resolve(event.code), { once: true });
      });
      client.socket.terminate();
      expect(await closed).toBe(4001);
    } finally {
      f.close();
    }
  });
  test("forwards native human questions and correlated answers, including errors", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      for (const [index, method] of [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
      ].entries()) {
        const question = {
          id: `question-${index}`,
          method,
          params: { threadId: identity.threadId },
        };
        for (const peer of f.peers) peer.send(JSON.stringify(question));
        await until(() => client.frames.some((frame) => frame["id"] === question.id));
        expect(client.frames.find((frame) => frame["id"] === question.id)).toEqual(question);
        const answer =
          index === 4
            ? { id: question.id, error: { code: -32601, message: "unsupported form" } }
            : { id: question.id, result: { decision: "decline" } };
        client.socket.send(JSON.stringify(answer));
        await until(() => f.calls.some((frame) => frame["id"] === question.id));
        expect(f.calls.find((frame) => frame["id"] === question.id)).toEqual(answer);
      }
      const prior = f.calls.length;
      client.socket.send(JSON.stringify({ id: "unseen", result: { decision: "accept" } }));
      client.socket.send(
        JSON.stringify({ id: 77, method: "thread/read", params: { threadId: identity.threadId } }),
      );
      await until(() => f.calls.some((frame) => frame["id"] === 77));
      expect(f.calls.length).toBe(prior + 1);
    } finally {
      f.close();
    }
  });
  test("resume preserves existing permissions and other native settings", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({
          id: 2,
          method: "thread/resume",
          params: {
            threadId: identity.threadId,
            cwd: identity.workspace,
            sandbox: "danger-full-access",
            approvalPolicy: "never",
            config: { default_permissions: ":danger-full-access" },
            model: "local-default",
            excludeTurns: true,
          },
        }),
      );
      await until(() => client.frames.length === 2);
      expect(f.calls.find((call) => call["method"] === "thread/resume")?.["params"]).toEqual({
        threadId: identity.threadId,
        excludeTurns: true,
      });
    } finally {
      f.close();
    }
  });
  test("resolved and other-thread questions cannot be answered through the attachment", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      for (const peer of f.peers) {
        peer.send(
          JSON.stringify({
            id: "other",
            method: "item/commandExecution/requestApproval",
            params: { threadId: "other" },
          }),
        );
        peer.send(
          JSON.stringify({
            id: "resolved",
            method: "item/commandExecution/requestApproval",
            params: { threadId: identity.threadId },
          }),
        );
        peer.send(
          JSON.stringify({
            method: "serverRequest/resolved",
            params: { threadId: identity.threadId, requestId: "resolved" },
          }),
        );
      }
      await until(() =>
        client.frames.some((frame) => frame["method"] === "serverRequest/resolved"),
      );
      client.socket.send(JSON.stringify({ id: "other", result: { decision: "accept" } }));
      client.socket.send(JSON.stringify({ id: "resolved", result: { decision: "accept" } }));
      client.socket.send(
        JSON.stringify({ id: 78, method: "thread/read", params: { threadId: identity.threadId } }),
      );
      await until(() => f.calls.some((frame) => frame["id"] === 78));
      expect(f.calls.some((frame) => frame["id"] === "other" || frame["id"] === "resolved")).toBe(
        false,
      );
      expect(client.frames.some((frame) => frame["id"] === "other")).toBe(false);
    } finally {
      f.close();
    }
  });
  test("revocation disconnects both sockets and prevents stale credentials from rejoining", async () => {
    const f = fixture();
    try {
      const ticket = f.gateway.issue(identity);
      const client = await f.client(ticket);
      f.gateway.revoke();
      await until(
        () =>
          client.socket.readyState === WebSocket.CLOSED &&
          client.watch.readyState === WebSocket.CLOSED,
      );
      await until(() => f.peers.size === 0);
      const response = await fetch(ticket.url.replace("ws:", "http:"), {
        headers: { Authorization: `Bearer ${ticket.token}` },
      });
      expect(response.status).toBe(401);
      expect(f.gateway.issue(identity).token).not.toBe(ticket.token);
    } finally {
      f.close();
    }
  });
});

test("speech CLI parses workspace selection and literal Unicode text", () => {
  expect(parseSpeechArgs(["Hello café 👋"]).text).toBe("Hello café 👋");
  expect(parseSpeechArgs(["Hello"]).workspace).toBe(identity.workspace);
  expect(parseSpeechArgs(["--thread", "owned-thread", "--", "--hello"]).text).toBe("--hello");
  expect(parseSpeechArgs(["--thread", "owned-thread", "hi"]).threadId).toBe("owned-thread");
  expect(() => parseSpeechArgs([])).toThrow("nonempty");
  expect(() => parseSpeechArgs(["--workspace"])).toThrow("Missing value");
  expect(() => parseSpeechArgs(["--wat", "hi"])).toThrow("Unknown option");
});

test("speech uses the guarded connection once without a turn or resume", async () => {
  const f = fixture();
  try {
    await sendSpeech(f.gateway.issue(identity), "Hello café 👋");
    expect(f.calls.map((frame) => frame["method"])).toEqual([
      "initialize",
      "initialized",
      "thread/realtime/appendSpeech",
    ]);
    expect(f.calls[2]!["params"]).toEqual({ threadId: identity.threadId, text: "Hello café 👋" });
  } finally {
    f.close();
  }
});

test("speech admission remains exact-thread and rejects invalid payloads", () => {
  const method = "thread/realtime/appendSpeech";
  expect(() =>
    validateAttachmentRequest(method, { threadId: identity.threadId, text: "Hello" }, identity),
  ).not.toThrow();
  for (const params of [
    { threadId: "another-thread", text: "Hello" },
    { threadId: identity.threadId, text: " " },
    { threadId: identity.threadId, text: "x".repeat(65537) },
    { threadId: identity.threadId, text: "Hello", role: "developer" },
  ])
    expect(() => validateAttachmentRequest(method, params, identity)).toThrow();
});

test("speech fails on revocation without retrying", async () => {
  const f = fixture();
  const ticket = f.gateway.issue(identity);
  f.gateway.revoke();
  try {
    await expect(sendSpeech(ticket, "Hello")).rejects.toThrow();
    expect(f.calls).toEqual([]);
  } finally {
    f.close();
  }
});

test("speech surfaces native rejection without retries", async () => {
  const f = fixture(false, true);
  try {
    await expect(sendSpeech(f.gateway.issue(identity), "Hello")).rejects.toThrow(
      "conversation is not running",
    );
    expect(
      f.calls.filter((frame) => frame["method"] === "thread/realtime/appendSpeech"),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
