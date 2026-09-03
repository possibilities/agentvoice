/**
 * Enough of the Agent Client Protocol over stdio to exercise FxAcpAdapter.
 * Prompt text drives behavior:
 *   say:<text>          stream <text> and end the turn
 *   slow:<ms>:<text>    stream <text> after <ms> unless cancelled
 *   ask:<text>          request permission first; allow -> "granted:<text>", reject -> "denied"
 *   fail                answer the prompt with a JSON-RPC error
 *   exit                terminate the process mid-turn
 * FAKE_ACP_STEER=1 advertises and serves `_fx/session/steer`.
 * FAKE_ACP_LIFECYCLE=1 advertises `_fx.lifecycle` and publishes the feed,
 * ending each turn on the feed BEFORE answering the prompt — the order the
 * real Fx uses, and the one that races a client into "Session is busy".
 */

const steerSupported = process.env["FAKE_ACP_STEER"] === "1";
const lifecycleSupported = process.env["FAKE_ACP_LIFECYCLE"] === "1";
const PROMPT_ANSWER_DELAY_MS = 60;
let lifecycleSequence = 0;
let fxTurnSequence = 0;
const SESSION_ID = "fake-session";

interface ActiveTurn {
  requestId: number;
  timer: ReturnType<typeof setTimeout> | null;
  fxTurnId: string;
}

let mode = "ask";
let requestedModel = "unknown";
let activeTurn: ActiveTurn | null = null;
let serverRequestSequence = 0;
const pendingPermissions = new Map<number, (allowed: boolean) => void>();
let buffer = "";

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id: number, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function chunk(text: string): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(lifecycleSupported && activeTurn ? { turn_id: activeTurn.fxTurnId } : {}),
        content: { type: "text", text },
      },
    },
  });
}

function lifecycle(event: string, fields: Record<string, unknown>): void {
  if (!lifecycleSupported) return;
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "_fx/lifecycle",
        event,
        sequence: ++lifecycleSequence,
        agent_role: "main",
        agent_name: null,
        attention_kind: null,
        ...fields,
      },
    },
  });
}

function endTurn(stopReason: string): void {
  const turn = activeTurn;
  if (!turn) return;
  activeTurn = null;
  const outcome = stopReason === "cancelled" ? "interrupted" : "completed";
  lifecycle("turn_ended", {
    turn_id: turn.fxTurnId,
    agent_state: "idle",
    outcome,
    provider_disposition: null,
  });
  // Answer late, so a client that treats `turn_ended` as the free slot
  // sends its next prompt while this one is still open.
  if (lifecycleSupported) {
    setTimeout(() => respond(turn.requestId, { stopReason }), PROMPT_ANSWER_DELAY_MS);
  } else {
    respond(turn.requestId, { stopReason });
  }
}

function handlePrompt(id: number, text: string): void {
  if (activeTurn) {
    fail(id, -32603, "Session is busy");
    return;
  }
  activeTurn = { requestId: id, timer: null, fxTurnId: String(++fxTurnSequence) };
  lifecycle("turn_started", { turn_id: activeTurn.fxTurnId, agent_state: "working" });
  if (text.startsWith("say:")) {
    activeTurn.timer = setTimeout(() => {
      chunk(text.slice(4));
      endTurn("end_turn");
    }, 10);
    return;
  }
  if (text.startsWith("slow:")) {
    const [, delay, payload] = text.split(":", 3);
    activeTurn.timer = setTimeout(() => {
      chunk(payload ?? "");
      endTurn("end_turn");
    }, Number(delay));
    return;
  }
  if (text.startsWith("ask:")) {
    const payload = text.slice(4);
    const requestId = ++serverRequestSequence;
    pendingPermissions.set(requestId, (allowed) => {
      chunk(allowed ? `granted:${payload}` : "denied");
      endTurn("end_turn");
    });
    write({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: "call-1", title: "write file" },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
        ],
      },
    });
    return;
  }
  if (text === "fail") {
    activeTurn = null;
    fail(id, -32000, "boom");
    return;
  }
  if (text === "exit") {
    process.exit(3);
  }
  activeTurn.timer = setTimeout(() => {
    chunk(`echo:${text}`);
    endTurn("end_turn");
  }, 10);
}

function handle(message: Record<string, unknown>): void {
  const id = message["id"];
  const method = message["method"];
  const params = (message["params"] ?? {}) as Record<string, unknown>;

  if (typeof method !== "string") {
    if (typeof id === "number" && pendingPermissions.has(id)) {
      const settle = pendingPermissions.get(id)!;
      pendingPermissions.delete(id);
      const result = message["result"] as { outcome?: { outcome?: string; optionId?: string } };
      settle(result?.outcome?.outcome === "selected" && result.outcome.optionId === "allow");
    }
    return;
  }
  if (typeof id !== "number") return;

  switch (method) {
    case "initialize":
      lifecycleSequence = 0;
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-fx", version: "0.0.0-fake" },
        agentCapabilities:
          steerSupported || lifecycleSupported
            ? {
                _fx: {
                  ...(steerSupported ? { steer: true, snapshot: true } : {}),
                  ...(lifecycleSupported ? { lifecycle: 1 } : {}),
                },
              }
            : {},
      });
      return;
    case "session/new":
      requestedModel = process.env["FAKE_ACP_MODEL"] ?? "gpt-5.6-terra";
      respond(id, {
        sessionId: SESSION_ID,
        configOptions: [
          { id: "provider", currentValue: "codex" },
          { id: "model", currentValue: requestedModel },
        ],
        modes: { currentModeId: mode },
      });
      return;
    case "session/set_mode":
      mode = String(params["modeId"]);
      respond(id, null);
      return;
    case "session/prompt": {
      const prompt = params["prompt"] as Array<{ text?: string }>;
      handlePrompt(id, prompt[0]?.text ?? "");
      return;
    }
    case "session/cancel": {
      const turn = activeTurn;
      if (turn?.timer) clearTimeout(turn.timer);
      if (turn) endTurn("cancelled");
      respond(id, null);
      return;
    }
    case "_fx/session/steer": {
      if (!steerSupported) {
        // Newer fx answers unknown methods with -32600 rather than -32601.
        fail(
          id,
          process.env["FAKE_ACP_UNKNOWN_CODE"] === "-32600" ? -32600 : -32601,
          "Invalid request",
        );
        return;
      }
      if (activeTurn) {
        chunk(` +steer:${String(params["text"])}`);
        respond(id, { turnId: "fake-active-turn", disposition: "steering" });
      } else {
        respond(id, { turnId: "fake-idle-turn", disposition: "queued" });
      }
      return;
    }
    default:
      fail(id, -32601, "Method not found");
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
