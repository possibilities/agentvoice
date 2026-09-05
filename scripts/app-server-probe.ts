#!/usr/bin/env bun
/** Read-only native stdio smoke probe: no turns, audio, or service changes. */
import { realpathSync } from "node:fs";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";

const connection = await AppServerConnection.connect({
  argv: appServerArgv(process.env["CODEX_PATH"] ?? "codex"),
  cwd: realpathSync(process.cwd()),
  clientVersion: "stdio-probe",
  onNotification() {},
  onClose() {},
});
try {
  const result = await connection.request<{ data?: unknown[] }>("thread/list", {
    cwd: realpathSync(process.cwd()),
    sourceKinds: ["appServer"],
    archived: false,
    modelProviders: [],
    sortKey: "updated_at",
    limit: 1,
  });
  if (!Array.isArray(result.data)) throw new Error("thread/list returned no data array");
  console.log("native stdio initialize + workspace-filtered thread/list: PASS");
} finally {
  await connection.close();
}
