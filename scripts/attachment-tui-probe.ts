#!/usr/bin/env bun
/** Opt-in interactive stock TUI fixture: all model responses are local fakes; no audio. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AttachmentGateway } from "../src/attachment/gateway.ts";
import { runComposition } from "../src/composition/launch.ts";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION, type ControlStatus } from "../src/control/types.ts";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";

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
let frontend: VoiceServer | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const done = Promise.withResolvers<void>();
const stop = () => done.resolve();
let holdNext = false;
let streamNext = false;
let approvalNext = false;
let spawnNext = false;
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
    idleTimeout: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ data: [] });
      const body = (await request.json()) as { input?: unknown };
      const sequence = ++count;
      console.log(`MOCK TURN ${sequence}: ${JSON.stringify(body.input).slice(-300)}`);
      if (approvalNext || spawnNext) {
        const spawn = spawnNext;
        approvalNext = false;
        spawnNext = false;
        const item = {
          type: "function_call",
          id: `tool-${sequence}`,
          call_id: `call-${sequence}`,
          name: spawn ? "spawn_agent" : "exec_command",
          ...(spawn ? { namespace: "collaboration" } : {}),
          arguments: JSON.stringify(
            spawn
              ? {
                  message: "Return a short fixture reply.",
                  task_name: `probe_child_${sequence}`,
                }
              : {
                  cmd: "printf native-approval-confirmed",
                  sandbox_permissions: "require_escalated",
                  justification: "Run the harmless local attachment approval test?",
                },
          ),
        };
        const frames = [
          {
            type: "response.created",
            response: { id: `response-${sequence}`, status: "in_progress", output: [] },
          },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: `response-${sequence}`,
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        return new Response(
          frames
            .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (holdNext) {
        holdNext = false;
        held = Promise.withResolvers<void>();
        console.log("HELD");
        await held.promise;
        held = undefined;
      }
      const id = `response-${sequence}`;
      // Stock TUI commits complete Markdown lines while streaming; leave a final line pending.
      const text = `Local mock reply ${sequence}. No model inference was used.\n\nStill streaming.`;
      const item = {
        id: `message-${sequence}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
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
      const encode = (frame: (typeof frames)[number] | Record<string, unknown>) =>
        new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      if (streamNext) {
        streamNext = false;
        const release = Promise.withResolvers<void>();
        held = release;
        let started = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!started) {
                started = true;
                controller.enqueue(encode(frames[0]!));
                controller.enqueue(encode(frames[1]!));
                controller.enqueue(
                  encode({
                    type: "response.content_part.added",
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                );
                controller.enqueue(
                  encode({
                    type: "response.output_text.delta",
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    delta: text,
                  }),
                );
                console.log(`STREAMING ${sequence}`);
                return;
              }
              await release.promise;
              if (held === release) held = undefined;
              if (request.signal.aborted) return;
              for (const frame of frames.slice(2)) controller.enqueue(encode(frame));
              controller.close();
            },
            cancel() {
              release.resolve();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  writeFileSync(
    join(nativeHome, "config.toml"),
    `model = "gpt-6-astra"\nmodel_provider = "attachment-probe"\n[features]\nhooks = true\nmulti_agent_v2 = true\n[multi_agent_v2]\ntool_namespace = "collaboration"\n[model_providers.attachment-probe]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  writeFileSync(
    join(nativeHome, "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^exec_command$",
            hooks: [{ type: "command", command: "/usr/bin/true" }],
          },
        ],
      },
    }),
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
    nativeStateDir: stateDir,
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, CODEX_HOME: nativeHome },
    clientVersion: "attachment-tui-probe",
    // Match the owner connection's production opt-outs; the TUI has its own subscription.
    optOutNotificationMethods: ["item/agentMessage/delta", "item/commandExecution/outputDelta"],
    onNotification(method, params) {
      if (method === "turn/completed") turnEnded.resolve();
      if (method === "thread/settings/updated")
        console.log(`SETTINGS ${JSON.stringify(params["threadSettings"])}`);
    },
    onInteraction(message) {
      console.log(message);
    },
    onClose() {},
  });
  const started = await connection.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
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
  gateway = new AttachmentGateway(
    connection.nativeEndpoint!,
    codex,
    (threadId, timeoutMs) =>
      connection!.request("thread/read", { threadId, includeTurns: false }, timeoutMs),
    (method, result) => console.log(`TUI ${method}: ${result}`),
  );
  const status: ControlStatus = {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
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
      voiceSet: async () => {
        throw new Error("not used");
      },
      mailboxOpen: async () => {
        throw new Error("not used");
      },
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
  if (process.env["AGENTVOICE_TUI_PROBE_COMPOSITION"] === "1") {
    process.env["XDG_STATE_HOME"] = join(root, "state");
    process.env["AGENTVOICE_TUI_PROBE_ROOT"] = root;
    frontend = new VoiceServer(frontendSocketPath(stateDir), async () => ({
      identity: () => ({ workspace, threadId }),
      state: () => ({
        available: true,
        codingActivity: "unknown" as const,
        phase: "live" as const,
        mic: { muted: true, effectiveMuted: true },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      command: () => {},
      close: async () => {},
    }));
    await frontend.start();
    await runComposition(undefined, [
      process.execPath,
      fileURLToPath(
        new URL("../tests/fixtures/attachment-tui-composition-child.ts", import.meta.url),
      ),
    ]);
  } else {
    // Local controls arm fake responses/tool calls; "owner" submits them through the native thread.
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
      if (line === "stream") {
        streamNext = true;
        console.log("STREAM ARMED");
      }
      if (line === "approval") {
        approvalNext = true;
        console.log("APPROVAL ARMED");
      }
      if (line === "subagent") {
        spawnNext = true;
        console.log("SUBAGENT ARMED");
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
  }
} finally {
  clearTimeout(deadline);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  input?.close();
  await frontend?.close();
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
