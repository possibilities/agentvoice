import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentGateway, type AttachmentTicket } from "../src/attachment/gateway.ts";
import { attachmentArgv } from "../src/attachment/launcher.ts";
import { attachmentNotification, validateAttachmentRequest } from "../src/attachment/policy.ts";
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
function fixture(holdUnsubscribe = false) {
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
        if (frame.id !== undefined) {
          const respond = () =>
            peer.send(
              JSON.stringify({
                id: frame.id,
                result:
                  frame.method === "thread/read"
                    ? { thread: { id: identity.threadId, cwd: identity.workspace } }
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
            "stdio://",
          ],
          cwd: root,
          clientVersion: "test",
          tuiNativeStateDir: root,
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
  test("opt-in is launch-only and TUI argv pins endpoint, workspace and full access", () => {
    expect(parseArgs(["--allow-full-access", "--allow-tui-attach"]).allowTuiAttach).toBe(true);
    expect(parseArgs(["--allow-full-access"]).allowTuiAttach).toBeUndefined();
    const argv = attachmentArgv({
      ...identity,
      token: "private",
      url: "ws://127.0.0.1:42",
      codex: "/stock/codex",
    });
    expect(argv).not.toContain("private");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe(identity.threadId);
  });
  test("rejects permission, identity, workspace and hidden override changes before dispatch", () => {
    expect(() =>
      validateAttachmentRequest("thread/settings/update", settings, identity),
    ).not.toThrow();
    for (const params of [
      { ...settings, approvalPolicy: "on-request" },
      { ...settings, sandboxPolicy: { type: "readOnly" } },
      { ...settings, permissions: ":workspace" },
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
  test("forwards valid calls, refuses invalid mutations locally and never forwards TUI answers", async () => {
    const f = fixture();
    try {
      const client = await f.client(f.gateway.issue(identity));
      client.socket.send(
        JSON.stringify({ id: 2, method: "thread/read", params: { threadId: identity.threadId } }),
      );
      await until(() => client.frames.length === 2);
      expect(f.calls.some((call) => call["method"] === "thread/read")).toBe(true);
      client.socket.send(
        JSON.stringify({
          id: 3,
          method: "thread/settings/update",
          params: { ...settings, approvalPolicy: "on-request" },
        }),
      );
      await until(() => client.frames.length === 3);
      expect(client.frames[2]).toHaveProperty("error");
      expect(f.calls.some((call) => call["method"] === "thread/settings/update")).toBe(false);
      for (const peer of f.peers)
        peer.send(
          JSON.stringify({
            id: "question",
            method: "item/tool/requestUserInput",
            params: { threadId: identity.threadId },
          }),
        );
      client.socket.send(
        JSON.stringify({ id: "question", result: { answers: { q: { answers: ["yes"] } } } }),
      );
      await until(() => client.socket.readyState === WebSocket.CLOSED);
      expect(client.frames.some((frame) => frame["method"] === "item/tool/requestUserInput")).toBe(
        false,
      );
      expect(f.calls.some((frame) => frame["result"] !== undefined)).toBe(false);
      client.socket.close();
      client.watch.close();
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
