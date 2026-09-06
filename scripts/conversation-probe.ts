#!/usr/bin/env bun
/** Stock native read APIs only: disposable CODEX_HOME, network denied, no turns or media. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";
import { ConversationReader } from "../src/core/conversation-reader.ts";
import { confirmFullAccess } from "../src/core/full-access.ts";
import { conversationRequestSchemas, readResultSchema } from "../src/events/conversation.ts";

if (process.platform !== "darwin")
  throw new Error("This opt-in probe requires macOS sandbox-exec to deny network access.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-conversation-probe-")));
const nativeHome = join(root, "codex");
const workspace = join(root, "workspace");
mkdirSync(nativeHome);
mkdirSync(workspace);
let connection: AppServerConnection | undefined;
try {
  connection = await AppServerConnection.connect({
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1) (allow default) (deny network*)",
      ...appServerArgv(process.env["CODEX_PATH"] ?? "codex", [
        "sandbox_mode=danger-full-access",
        "approval_policy=never",
      ]),
    ],
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: nativeHome },
    clientVersion: "conversation-probe",
    onNotification() {},
    onClose() {},
  });
  const started = await connection.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    threadSource: "agentvoice-orchestrator",
  });
  confirmFullAccess(started);
  const reader = new ConversationReader(
    (method, params, timeout) => connection!.request(method, params, timeout),
    workspace,
    () => 0,
  );
  const identity = {
    expectedInstanceId: "probe",
    expectedGeneration: 1,
    rootThreadId: started.thread.id,
    threadId: started.thread.id,
  };
  for (const method of [
    "conversation.thread.get",
    "conversation.turns.list",
    "conversation.items.list",
    "conversation.threads.list",
  ] as const) {
    const { threadId, ...rootIdentity } = identity;
    const params = conversationRequestSchemas[method].parse(
      method === "conversation.threads.list" ? rootIdentity : identity,
    );
    if (method === "conversation.turns.list" || method === "conversation.items.list") {
      await assert.rejects(reader.read(method, params), { code: "history_unavailable" });
      continue;
    }
    const result = await reader.read(method, params);
    assert(readResultSchema.safeParse(result).success);
    assert.equal(result.nextCursor, null);
    assert.equal(result.changedDuringRead, false);
    if (method !== "conversation.thread.get") assert.deepEqual(result.data, []);
  }
  console.log(
    "conversation read APIs: PASS (scoped metadata, descendant listing, explicit unmaterialized history; no turns, network, or media)",
  );
} finally {
  await connection?.close();
  rmSync(root, { recursive: true, force: true });
}
