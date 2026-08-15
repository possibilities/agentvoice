#!/usr/bin/env bun
/**
 * Upstream-semantics probe for the resident app-server architecture: a codex
 * app-server on `--listen unix://` must accept sequential WebSocket-framed
 * connections, keep threads and running turns alive across a client
 * disconnect, reattach thread listeners on resume, and serve the realtime
 * surface from a socket connection with the ordinary ChatGPT bearer.
 * Re-run before bumping the supported codex version.
 *
 * Spends real tokens: two tiny turns and a few seconds of realtime session
 * against the canonical login. Probe threads are deleted afterwards.
 *
 * The abandoned-tool-call phase is observational, not pass/fail: its outcome
 * (does an unanswered dynamic tool call fail the turn, park it, or resolve
 * when the answer never comes?) shapes worker reconciliation, so the report
 * states what happened rather than asserting a guess.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { REALTIME_FEATURE } from "../src/core/appserver.ts";
import { ResidentAttachment } from "../src/core/attach.ts";

const RPC_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;
const PROBE_THREAD_SOURCE = "agentvoice-resident-probe";

interface Waiter {
  method: string;
  match(params: Record<string, unknown>): boolean;
  resolve(params: Record<string, unknown>): void;
}

interface ProbeClient {
  attachment: ResidentAttachment;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  waitForNotification(
    method: string,
    match: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  /** Requests seen with their params; answered per `answerTools`. */
  toolCalls: Array<Record<string, unknown>>;
  detach(): void;
  closedInfo(): { expected: boolean; error?: string } | null;
}

async function connectClient(
  socketPath: string,
  label: string,
  answerTools: "echo" | "never",
): Promise<ProbeClient> {
  const waiters: Waiter[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let closed: { expected: boolean; error?: string } | null = null;
  const attachment = await ResidentAttachment.connect({
    socketPath,
    clientVersion: "resident-probe",
    onNotification(method, params) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter && waiter.method === method && waiter.match(params)) {
          waiters.splice(i, 1);
          waiter.resolve(params);
        }
      }
    },
    onRequest(method, params) {
      if (method !== "item/tool/call") return null;
      toolCalls.push(params);
      console.log(`  [${label}] item/tool/call arrived: ${JSON.stringify(params).slice(0, 200)}`);
      if (answerTools === "echo") {
        return Promise.resolve({
          contentItems: [{ type: "inputText", text: "echo from probe" }],
          success: true,
        });
      }
      // Deliberately never answer: the probe then drops the connection to
      // observe what an unanswerable request does to the turn.
      return new Promise(() => {});
    },
    onClose(info) {
      closed = info;
    },
  });
  return {
    attachment,
    request: (method, params, timeoutMs = RPC_TIMEOUT_MS) =>
      attachment.request(method, params, timeoutMs),
    waitForNotification(method, match, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no ${method} within ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({
          method,
          match,
          resolve: (params) => {
            clearTimeout(timer);
            resolve(params);
          },
        });
      });
    },
    toolCalls,
    detach: () => attachment.close(),
    closedInfo: () => closed,
  };
}

function extractThreadId(result: unknown): string {
  const id = (result as { thread?: { id?: string } })?.thread?.id;
  if (!id) throw new Error("no thread id in response");
  return id;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`socket ${path} did not appear within ${timeoutMs}ms`);
}

async function buildOffer(): Promise<{ pc: RTCPeerConnection; sdp: string }> {
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })],
    },
  });
  pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });
  pc.createDataChannel("oai-events");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("no local description");
  return { pc, sdp };
}

const root = mkdtempSync(join(tmpdir(), "av-resident-"));
const socketDir = join(root, "s");
mkdirSync(socketDir, { mode: 0o700 });
const socketPath = join(socketDir, "as.sock");
const workspace = join(root, "workspace");
mkdirSync(workspace);
const processCwd = join(root, "appserver");
mkdirSync(processCwd);

console.log(`socket: ${socketPath}`);
const child: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
  ["codex", "app-server", "--enable", REALTIME_FEATURE, "--listen", `unix://${socketPath}`],
  { cwd: processCwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
);
const stderrChunks: string[] = [];
void (async () => {
  for await (const chunk of child.stderr) stderrChunks.push(new TextDecoder().decode(chunk));
})();

let failed = false;
const threadIds: string[] = [];
try {
  await waitForSocket(socketPath, 15_000);

  console.log("phase 1: attach, initialize, thread/start with a dynamic tool");
  const c1 = await connectClient(socketPath, "c1", "echo");
  const started = await c1.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    threadSource: PROBE_THREAD_SOURCE,
    dynamicTools: [
      {
        type: "function",
        name: "probe_echo",
        description: "Echo the message back. Call this exactly once when asked.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  });
  const threadId = extractThreadId(started);
  threadIds.push(threadId);
  console.log(`  thread ${threadId}`);
  // A pre-turn thread has no rollout and cannot be resumed; materialize it.
  const firstTurn = (await c1.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly: ok" }],
  })) as { turn?: { id?: string } };
  if (!firstTurn?.turn?.id) throw new Error("materializing turn/start returned no turn id");
  await c1.waitForNotification(
    "turn/completed",
    (params) => params["threadId"] === threadId,
    TURN_TIMEOUT_MS,
  );
  console.log("  materializing turn completed");

  console.log("phase 2: detach, reattach on a second connection, thread/resume");
  c1.detach();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!child.killed && child.exitCode === null) {
    console.log("  app-server survived the disconnect");
  } else {
    throw new Error(`app-server exited on client disconnect (code ${child.exitCode})`);
  }
  const c2 = await connectClient(socketPath, "c2", "echo");
  const resumed = await c2.request("thread/resume", { threadId, excludeTurns: true });
  if (extractThreadId(resumed) !== threadId) throw new Error("resume returned a different thread");
  console.log("  resumed on a fresh connection");

  console.log("phase 3: start a turn, detach mid-turn, verify it completes while detached");
  const turn = (await c2.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly: RESIDENT_OK — nothing else." }],
  })) as { turn?: { id?: string } };
  if (!turn?.turn?.id) throw new Error("turn/start returned no turn id");
  console.log(`  turn ${turn.turn.id} started; detaching now`);
  c2.detach();
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const c3 = await connectClient(socketPath, "c3", "echo");
  let sawCompletionNotification = false;
  try {
    const reresumed = await c3.request("thread/resume", { threadId, excludeTurns: true });
    if (extractThreadId(reresumed) !== threadId) throw new Error("re-resume mismatched");
    console.log("  thread/resume succeeded while the turn was in flight");
    try {
      await c3.waitForNotification(
        "turn/completed",
        (params) => params["threadId"] === threadId,
        TURN_TIMEOUT_MS,
      );
      sawCompletionNotification = true;
      console.log("  turn/completed arrived on the reattached connection");
    } catch {
      console.log("  no turn/completed on the reattached connection (may have finished earlier)");
    }
  } catch (error) {
    console.log(
      `  thread/resume during a running turn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const read = (await c3.request("thread/read", { threadId, includeTurns: true })) as Record<
    string,
    unknown
  >;
  const readText = JSON.stringify(read);
  if (!readText.includes("RESIDENT_OK")) {
    throw new Error("the detached turn's reply is missing from thread history");
  }
  console.log(
    `  detached turn completed (reply in history; completion notification ${
      sawCompletionNotification ? "reattached" : "not observed"
    })`,
  );

  console.log("phase 4: realtime over the unix connection");
  const { pc, sdp } = await buildOffer();
  try {
    const realtimeSessionId = "probe-rt-1";
    const answerWait = c3.waitForNotification(
      "thread/realtime/sdp",
      (params) => typeof params["sdp"] === "string",
      45_000,
    );
    const startedWait = c3.waitForNotification(
      "thread/realtime/started",
      (params) => params["realtimeSessionId"] === realtimeSessionId,
      45_000,
    );
    await c3.request("thread/realtime/start", {
      threadId,
      realtimeSessionId,
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp },
    });
    await Promise.all([answerWait, startedWait]);
    console.log("  realtime started and answered over the socket connection");
    const closedWait = c3.waitForNotification("thread/realtime/closed", () => true, 30_000);
    await c3.request("thread/realtime/stop", { threadId });
    const closedParams = await closedWait;
    console.log(`  realtime closed (${JSON.stringify(closedParams["reason"])})`);
  } finally {
    await pc.close();
  }

  console.log("phase 5 (observational): abandon an unanswered dynamic tool call");
  c3.detach();
  const c4 = await connectClient(socketPath, "c4", "never");
  const t2 = extractThreadId(
    await c4.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      threadSource: PROBE_THREAD_SOURCE,
      dynamicTools: [
        {
          type: "function",
          name: "probe_echo",
          description: "Echo the message back. Call this exactly once when asked.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    }),
  );
  threadIds.push(t2);
  await c4.request("turn/start", {
    threadId: t2,
    input: [{ type: "text", text: "Call the probe_echo tool with message='ping'." }],
  });
  const callDeadline = Date.now() + TURN_TIMEOUT_MS;
  while (c4.toolCalls.length === 0 && Date.now() < callDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (c4.toolCalls.length === 0) {
    console.log("  OBSERVED: the model never called the tool; phase inconclusive");
    c4.detach();
  } else {
    console.log("  tool call in flight and unanswered; detaching");
    c4.detach();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const c5 = await connectClient(socketPath, "c5", "echo");
    const deadline = Date.now() + 60_000;
    let outcome = "unknown";
    for (;;) {
      const state = (await c5.request("thread/read", { threadId: t2, includeTurns: true })) as {
        thread?: { status?: { type?: string } };
      };
      const status = state.thread?.status?.type ?? "unknown";
      // "active" means a turn is in flight; only idle/notLoaded are settled.
      if (status === "idle" || status === "notLoaded" || Date.now() > deadline) {
        outcome = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    console.log(`  OBSERVED: thread status 60s after abandoning the tool call: ${outcome}`);
    if (outcome !== "idle" && outcome !== "notLoaded") {
      console.log("  OBSERVED: the turn is parked — reconciliation must interrupt such turns");
      try {
        const state = (await c5.request("thread/read", { threadId: t2, includeTurns: true })) as {
          thread?: { turns?: Array<{ id?: string; status?: string }> };
        };
        const turns = state.thread?.turns ?? [];
        console.log(
          `  turn statuses: ${JSON.stringify(turns.map((entry) => entry.status ?? "?"))}`,
        );
        const parked = [...turns]
          .reverse()
          .find((entry) => !["completed", "failed", "interrupted"].includes(entry.status ?? ""));
        if (parked?.id) {
          await c5.request("turn/interrupt", { threadId: t2, turnId: parked.id });
          console.log("  interrupted the parked turn");
        }
      } catch (error) {
        console.log(
          `  cleanup interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    c5.detach();
  }

  console.log("cleanup: deleting probe threads");
  const cleanup = await connectClient(socketPath, "cleanup", "echo");
  for (const id of threadIds) {
    await cleanup.request("thread/delete", { threadId: id }).then(
      () => console.log(`  deleted probe thread ${id}`),
      (error) =>
        console.log(
          `  thread/delete ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }
  cleanup.detach();

  console.log("resident probe: PASS");
} catch (error) {
  failed = true;
  console.error(`resident probe: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  const tail = stderrChunks.join("").split("\n").slice(-12).join("\n");
  if (tail.trim().length > 0) console.error(`app-server stderr tail:\n${tail}`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    child.exited,
    new Promise((resolve) => setTimeout(resolve, 3_000)).then(() => child.kill("SIGKILL")),
  ]);
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
