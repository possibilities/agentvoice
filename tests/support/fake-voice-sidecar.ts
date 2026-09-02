/**
 * Enough of the voice sidecar's JSON-RPC surface over stdio to exercise
 * VoiceSession: initialize, listVoices, thread/start, realtime start/stop
 * with their notifications, appendSpeech, and delete.
 *   offer text containing "fail"  -> thread/realtime/error instead of started
 *   FAKE_SIDECAR_UPSTREAM_CLOSE_MS -> closes the session upstream after N ms
 */

const THREAD_ID = "thread-1";
const upstreamCloseMs = Number(process.env["FAKE_SIDECAR_UPSTREAM_CLOSE_MS"] ?? "0");
let active = false;
let upstreamTimer: ReturnType<typeof setTimeout> | null = null;
let buffer = "";

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  write({ jsonrpc: "2.0", method, params });
}

function handle(message: Record<string, unknown>): void {
  const id = message["id"];
  const method = message["method"];
  const params = (message["params"] ?? {}) as Record<string, unknown>;
  if (typeof method !== "string") return;
  if (typeof id !== "number") return;

  switch (method) {
    case "initialize":
      write({ jsonrpc: "2.0", id, result: { userAgent: "fake-voice-sidecar/0.0.0" } });
      return;
    case "thread/realtime/listVoices":
      write({ jsonrpc: "2.0", id, result: { voices: ["cove"] } });
      return;
    case "thread/start":
      write({ jsonrpc: "2.0", id, result: { thread: { id: THREAD_ID } } });
      return;
    case "thread/realtime/start": {
      if (active) {
        write({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: `realtime conversation is already running for thread: ${THREAD_ID}`,
          },
        });
        return;
      }
      const transport = params["transport"] as { sdp?: string } | undefined;
      const offer = transport?.sdp ?? "";
      write({ jsonrpc: "2.0", id, result: {} });
      if (offer.includes("fail")) {
        notify("thread/realtime/error", { threadId: THREAD_ID, error: { message: "boom" } });
        return;
      }
      active = true;
      notify("thread/realtime/started", {
        threadId: THREAD_ID,
        realtimeSessionId: params["realtimeSessionId"],
        model: "gpt-live-1-codex",
      });
      notify("thread/realtime/sdp", { threadId: THREAD_ID, sdp: `answer:${offer}` });
      if (upstreamCloseMs > 0) {
        upstreamTimer = setTimeout(() => {
          if (!active) return;
          active = false;
          notify("thread/realtime/closed", { threadId: THREAD_ID, reason: "transport_closed" });
        }, upstreamCloseMs);
      }
      return;
    }
    case "thread/realtime/stop":
      if (upstreamTimer) clearTimeout(upstreamTimer);
      write({ jsonrpc: "2.0", id, result: {} });
      if (active) {
        active = false;
        notify("thread/realtime/closed", { threadId: THREAD_ID, reason: "requested" });
      }
      return;
    case "thread/realtime/appendSpeech":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "thread/delete":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown ${method}` } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data: string) => {
  buffer += data;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
