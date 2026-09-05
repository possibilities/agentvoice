#!/usr/bin/env bun
/** Opt-in native timeline check: synthetic rollouts, disposable home, no network/turns/media. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, AppServerError, appServerArgv } from "../src/core/attach.ts";
import { SpokenHistoryReader } from "../src/core/spoken-history.ts";

if (process.platform !== "darwin")
  throw new Error("This probe requires macOS sandbox-exec to deny network access.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-history-probe-")));
const nativeHome = join(root, "codex");
const workspace = join(root, "workspace");
const rollouts = join(nativeHome, "sessions", "2026", "09", "05");
mkdirSync(rollouts, { recursive: true });
mkdirSync(workspace);
const threadId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-05T14:53:44.690Z";
const records = [
  {
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp,
      cwd: workspace,
      originator: "agentvoice",
      cli_version: "0.153.4",
      source: "vscode",
      thread_source: "agentvoice-orchestrator",
      model_provider: "openai",
    },
  },
  ...[
    { type: "realtime_session_started" },
    { type: "transcript_segment", role: "user", text: "Name the files." },
    { type: "transcript_segment", role: "assistant", text: "FIRST.md, LAST.md." },
    { type: "realtime_session_closed", outcome: "ended" },
  ].map((payload, i) => ({
    type: "realtime_item",
    payload: { ...payload, id: `voice-item-${i}`, realtime_session_id: "voice-1" },
  })),
];
writeFileSync(
  join(rollouts, `rollout-2026-09-05T10-53-44-${threadId}.jsonl`),
  `${records.map((r) => JSON.stringify({ timestamp, ...r })).join("\n")}\n`,
);
let connection: AppServerConnection | undefined;
try {
  connection = await AppServerConnection.connect({
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1) (allow default) (deny network*)",
      ...appServerArgv(process.env["CODEX_PATH"] ?? "codex"),
    ],
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: nativeHome },
    clientVersion: "voice-history-probe",
    onNotification() {},
    onClose() {},
  });
  type Page = {
    data: { type: string; position: number; item: { type: string; text?: string } }[];
    nextCursor: string | null;
  };
  let page: Page | undefined;
  try {
    page = await connection.request<Page>("thread/timeline/list", { threadId, limit: 2 });
  } catch (error) {
    if (!(error instanceof AppServerError) || error.code !== -32601) throw error;
    console.log(
      "native timeline unavailable for legacy history; verifying native rollout fallback",
    );
  }
  if (page) {
    assert.deepEqual(
      page.data.map((e) => e.item.type),
      ["transcriptSegment", "realtimeSessionClosed"],
    );
    assert.equal(page.data[0]!.item.text, "FIRST.md, LAST.md.");
    assert.ok(page.nextCursor);
    const older = await connection.request<Page>("thread/timeline/list", {
      threadId,
      limit: 2,
      cursor: page.nextCursor,
    });
    assert.deepEqual(
      older.data.map((e) => e.item.type),
      ["realtimeSessionStarted", "transcriptSegment"],
    );
    assert.equal(older.nextCursor, null);
    assert.ok(older.data.at(-1)!.position < page.data[0]!.position);
    console.log(
      "native timeline: PASS (latest page, chronological entries, older cursor, exact speech)",
    );
  }
  const history = await new SpokenHistoryReader((method, params) =>
    connection!.request(method, params),
  ).read(threadId, workspace);
  assert.deepEqual(history, {
    items: [
      { role: "user", text: "Name the files." },
      { role: "assistant", text: "FIRST.md, LAST.md." },
    ],
    truncated: false,
  });
  console.log("spoken history: PASS (exact native speech restored without inference or media)");
} finally {
  await connection?.close();
  rmSync(root, { recursive: true, force: true });
}
