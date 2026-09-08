#!/usr/bin/env bun
/** Opt-in stock prompt-assembly probe: isolated state, fake responses, no audio/inference. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";
import { parseJsonConfig, readPrompts, resolveConfig } from "../src/core/config.ts";
import { threadParams } from "../src/core/params.ts";

if (process.platform !== "darwin") throw new Error("This probe requires macOS sandbox-exec.");
const codex = process.env["CODEX_PATH"];
const catalogPath = process.env["CODEX_MODEL_CATALOG"];
if (!codex?.startsWith("/") || !catalogPath?.startsWith("/"))
  throw new Error("Set absolute CODEX_PATH and CODEX_MODEL_CATALOG paths.");
const repo = realpathSync(join(import.meta.dir, ".."));
const fragment = parseJsonConfig(
  readFileSync(join(repo, "docs/delegation-policy.example.json"), "utf8"),
  "delegation policy example",
);
const feature = fragment.orchestrator?.config?.["features.multi_agent_v2"] as Record<
  string,
  unknown
>;
const policy = feature["multi_agent_mode_hint_text"];
assert.equal(typeof policy, "string");
const catalog = readFileSync(catalogPath, "utf8");
const root = realpathSync(mkdtempSync(join(tmpdir(), "av-delegation-probe-")));
const workspace = join(root, "workspace");
const nativeHome = join(root, "codex");
let connection: AppServerConnection | undefined;
let model: ReturnType<typeof Bun.serve> | undefined;
let completed = Promise.withResolvers<void>();
let captured: Record<string, unknown> | undefined;

function developerTexts(body: Record<string, unknown>): string[] {
  const items = body["input"] as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  return items
    .filter((item) => item.role === "developer")
    .map((item) => (item.content ?? []).map((content) => content.text ?? "").join("\n"));
}

async function capture(threadId: string): Promise<Record<string, unknown>> {
  completed = Promise.withResolvers<void>();
  captured = undefined;
  await connection!.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Local prompt-assembly fixture. Return no output." }],
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completed.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Fake turn timed out")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert(captured, "No outbound model request captured");
  return captured;
}

async function connect(): Promise<AppServerConnection> {
  return AppServerConnection.connect({
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      '(version 1) (allow default) (deny network*) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))',
      ...appServerArgv(codex!),
    ],
    nativeStateDir: root,
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, CODEX_HOME: nativeHome },
    clientVersion: "delegation-policy-probe",
    onNotification(method) {
      if (method === "turn/completed") completed.resolve();
    },
    onClose() {},
  });
}

function verifyPolicy(body: Record<string, unknown>, append: string): void {
  const texts = developerTexts(body);
  const mode = `<multi_agent_mode>${policy}</multi_agent_mode>`;
  const modeIndex = texts.findIndex((text) => text.includes(mode));
  const appendIndex = texts.findIndex((text) => text.includes(append));
  assert(appendIndex >= 0 && modeIndex > appendIndex, "Exact policy must follow the role append");
  assert(!texts.some((text) => text.includes("Any earlier instruction enabling proactive")));
  assert(JSON.stringify(body).includes("independently alongside useful local work"));
  // This is a later explicit policy exception, not removal of native tool guidance.
}

try {
  mkdirSync(workspace);
  mkdirSync(nativeHome);
  writeFileSync(join(root, "models.json"), catalog);
  model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
      captured = (await request.json()) as Record<string, unknown>;
      const id = crypto.randomUUID();
      const frames = [
        { type: "response.created", response: { id, status: "in_progress", output: [] } },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  writeFileSync(
    join(nativeHome, "config.toml"),
    `model = "gpt-6-astra"\nmodel_provider = "local-probe"\nmodel_reasoning_effort = "low"\nmodel_catalog_json = ${JSON.stringify(join(root, "models.json"))}\n[features]\nmulti_agent_v2 = true\n[model_providers.local-probe]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  const config = resolveConfig(
    {
      role: join(repo, "roles/default"),
      orchestrator: { workspace, sandbox: "read-only", "approval-policy": "never" },
    },
    fragment,
    {},
    root,
    { configDir: nativeHome },
  );
  const { prompts } = await readPrompts(config);
  const append = prompts.orchestratorDeveloperInstructions!;
  assert(append);
  connection = await connect();
  const baseline = await connection.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    ephemeral: true,
    developerInstructions: append,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  assert(
    developerTexts(await capture(baseline.thread.id)).some((text) =>
      text.includes("Any earlier instruction enabling proactive"),
    ),
    "Baseline changed: re-audit native/catalog defaults",
  );
  const started = await connection.request<{ thread: { id: string } }>(
    "thread/start",
    threadParams(config, prompts, "start"),
  );
  verifyPolicy(await capture(started.thread.id), append);
  await connection.close();
  connection = undefined;
  connection = await connect();
  const resumed = await connection.request<{ thread: { id: string } }>("thread/resume", {
    ...threadParams(config, prompts, "resume"),
    threadId: started.thread.id,
  });
  assert.equal(resumed.thread.id, started.thread.id);
  verifyPolicy(await capture(resumed.thread.id), append);
  console.log(
    "PASS: baseline conflict; exact policy after role append on start and owned-child replacement/resume. No live inference or audio.",
  );
} finally {
  try {
    await connection?.close();
  } finally {
    model?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
