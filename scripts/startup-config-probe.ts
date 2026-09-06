#!/usr/bin/env bun
/** Opt-in stock-Codex check: disposable state, network denied, no turns or media. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";

if (process.platform !== "darwin")
  throw new Error("This opt-in probe requires macOS sandbox-exec to deny network access.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-native-config-probe-")));
const nativeHome = join(root, "codex");
const workspace = join(root, "workspace");
mkdirSync(nativeHome);
mkdirSync(workspace);
writeFileSync(
  join(nativeHome, "config.toml"),
  'model = "file-model"\nmodel_reasoning_effort = "low"\n',
);
let connection: AppServerConnection | undefined;
try {
  const entries = [
    "model=earlier-model",
    "model=startup-model",
    "model_reasoning_effort=high",
    "sandbox_mode=danger-full-access",
    "approval_policy=never",
    'experimental_realtime_ws_startup_context=""',
  ];
  connection = await AppServerConnection.connect({
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1) (allow default) (deny network*)",
      ...appServerArgv(process.env["CODEX_PATH"] ?? "codex", entries),
    ],
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: nativeHome },
    clientVersion: "startup-config-probe",
    onNotification() {},
    onClose() {},
  });
  const result = await connection.request<{ config: Record<string, unknown> }>("config/read", {
    cwd: workspace,
    includeLayers: false,
  });
  assert.equal(result.config["model"], "startup-model");
  assert.equal(result.config["model_reasoning_effort"], "high");
  assert.equal(result.config["experimental_realtime_ws_startup_context"], "");
  for (const extra of [
    {},
    { config: { model: "request-config-model" } },
    { model: "typed-model", config: { model: "request-config-model" } },
  ]) {
    const response: Record<string, unknown> = await connection.request<Record<string, unknown>>(
      "thread/start",
      {
        cwd: workspace,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        ephemeral: true,
        ...extra,
      },
    );
    assert.equal(response["approvalPolicy"], "never");
    assert.deepEqual(response["sandbox"], { type: "dangerFullAccess" });
    assert.equal(
      response["model"],
      "model" in extra
        ? "typed-model"
        : "config" in extra
          ? "request-config-model"
          : "startup-model",
    );
    assert.equal((response["thread"] as Record<string, unknown>)["cwd"], workspace);
  }
  console.log(
    "native startup config: PASS (file < ordered startup -c < request config < typed model; empty value preserved)",
  );
} finally {
  await connection?.close();
  rmSync(root, { recursive: true, force: true });
}
