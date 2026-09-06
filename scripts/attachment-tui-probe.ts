#!/usr/bin/env bun
/** Opt-in interactive stock TUI fixture: all model responses are local fakes; no audio. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AttachmentGateway } from "../src/attachment/gateway.ts";
import { startControlServer } from "../src/control/index.ts";
import type { ControlStatus } from "../src/control/types.ts";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";

if (process.platform !== "darwin")
  throw new Error("This isolated fixture requires macOS sandbox-exec");
const codex = process.env["CODEX_PATH"];
if (!codex?.startsWith("/")) throw new Error("Set CODEX_PATH to an absolute stock executable");
const root = realpathSync(mkdtempSync(join(tmpdir(), "av-tui-probe-")));
const workspace = join(root, "workspace");
const nativeHome = join(root, "codex");
const stateDir = join(root, "state", "agentvoice");
let connection: AppServerConnection | undefined;
let gateway: AttachmentGateway | undefined;
let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
let model: ReturnType<typeof Bun.serve> | undefined;
let input: ReturnType<typeof createInterface> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const done = Promise.withResolvers<void>();
const stop = () => done.resolve();
let holdNext = false;
let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let count = 0;
const turnEnded = Promise.withResolvers<void>();
try {
  mkdirSync(workspace);
  mkdirSync(nativeHome);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
      const body = (await request.json()) as { input?: unknown };
      console.log(`MOCK TURN ${++count}: ${JSON.stringify(body.input).slice(-300)}`);
      if (holdNext) {
        holdNext = false;
        held = Promise.withResolvers<void>();
        console.log("HELD");
        await held.promise;
        held = undefined;
      }
      const id = `response-${count}`;
      const item = {
        id: `message-${count}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: `Local mock reply ${count}. No model inference was used.`,
            annotations: [],
          },
        ],
      };
      const frames = [
        { type: "response.created", response: { id, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [item],
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
    `model = "gpt-6-astra"\nmodel_provider = "attachment-probe"\n[model_providers.attachment-probe]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  deadline = setTimeout(stop, 10 * 60_000);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  connection = await AppServerConnection.connect({
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      '(version 1) (allow default) (deny network*) (allow network-bind (local ip "localhost:*")) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))',
      ...appServerArgv(codex),
    ],
    tuiNativeStateDir: stateDir,
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, CODEX_HOME: nativeHome },
    clientVersion: "attachment-tui-probe",
    onNotification(method) {
      if (method === "turn/completed") turnEnded.resolve();
    },
    onClose() {},
  });
  const started = await connection.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  const threadId = started.thread.id;
  await connection.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Seed the isolated attachment test." }],
  });
  await Promise.race([
    turnEnded.promise,
    Bun.sleep(15_000).then(() => {
      throw new Error("Mock seed turn timed out");
    }),
  ]);
  gateway = new AttachmentGateway(connection.nativeEndpoint!, codex, (method, result) =>
    console.log(`TUI ${method}: ${result}`),
  );
  const status: ControlStatus = {
    protocolVersion: 2,
    instanceId: `probe-${process.pid}`,
    generation: 1,
    workspace,
    threadId,
    runtime: { phase: "ready" },
    recentOperations: [],
  };
  control = await startControlServer({
    stateDir,
    instanceId: status.instanceId,
    backend: {
      status: () => status,
      redial: async () => {
        throw new Error("No media in fixture");
      },
      restart: async () => {
        throw new Error("No runtime restart in fixture");
      },
    },
    attachment: async () => gateway!.issue({ workspace, threadId }),
  });
  console.log(
    `READY ${JSON.stringify({ root, workspace, state: join(root, "state"), nativeHome, threadId })}`,
  );
  // Local fixture controls: hold/release a fake response, submit owner input, revoke, quit.
  input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line === "hold") {
      holdNext = true;
      console.log("ARMED");
    }
    if (line === "release") {
      held?.resolve();
      console.log("RELEASED");
    }
    if (line === "owner") {
      void connection!
        .request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Owner-originated test message." }],
        })
        .catch((error) => {
          console.error(error);
          stop();
        });
    }
    if (line === "revoke") {
      gateway?.revoke();
      console.log("REVOKED");
    }
    if (line === "quit") stop();
  });
  input.on("close", stop);
  await done.promise;
} finally {
  clearTimeout(deadline);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  input?.close();
  held?.resolve();
  gateway?.close();
  try {
    await control?.close();
  } finally {
    try {
      await connection?.close();
    } finally {
      model?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
