import type { RawFrameEvent } from "./model.ts";

export type TranscriptFamily =
  | "user"
  | "hook"
  | "agent"
  | "plan"
  | "reasoning"
  | "command"
  | "fileChange"
  | "tool"
  | "collab"
  | "web"
  | "media"
  | "wait"
  | "system"
  | "error"
  | "raw";

export interface TranscriptPlanStep {
  step: string;
  status: string;
}

export interface TranscriptChange {
  path: string;
  kind: string;
  diff: string;
  raw: Record<string, unknown>;
}

export interface TranscriptItem {
  id: string;
  turnId: string;
  type: string;
  family: TranscriptFamily;
  status: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: TranscriptChange[];
  diff?: string;
  toolName?: string;
  toolServer?: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
  progress?: string[];
  plan?: TranscriptPlanStep[];
  explanation?: string | null;
  startedAtMs?: number;
  completedAtMs?: number;
  raw: Record<string, unknown>;
}

export interface TranscriptTurn {
  id: string;
  status: string;
  error?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number | null;
  diff?: string;
  items: TranscriptItem[];
  raw: Record<string, unknown>;
}

export interface TranscriptState {
  threadId: string;
  turns: TranscriptTurn[];
  appliedFrameSequences: ReadonlySet<number>;
}

const MAX_APPLIED_FRAME_SEQUENCES = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : undefined;
}

function nullableNumberAt(value: Record<string, unknown>, key: string): number | null | undefined {
  return value[key] === null ? null : numberAt(value, key);
}

function secondsToMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * 1_000 : undefined;
}

function terminalStatus(status: string): boolean {
  return [
    "completed",
    "failed",
    "declined",
    "interrupted",
    "errored",
    "cancelled",
    "canceled",
    "blocked",
    "stopped",
  ].includes(status);
}

function mergeStatus(current: string, incoming: string): string {
  if (terminalStatus(current) && !terminalStatus(incoming)) return current;
  return incoming;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

function inputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = stringAt(entry, "type");
    if (type === "text") {
      const text = stringAt(entry, "text");
      if (text) parts.push(text);
    } else if (type === "skill") {
      parts.push(`$${stringAt(entry, "name") ?? "skill"}`);
    } else if (type === "mention") {
      parts.push(`@${stringAt(entry, "name") ?? "mention"}`);
    } else if (type === "localImage" || type === "localAudio") {
      parts.push(stringAt(entry, "path") ?? `[${type}]`);
    } else if (type === "image" || type === "audio") {
      parts.push(stringAt(entry, "url") ?? `[${type}]`);
    } else if (type) {
      parts.push(`[${type}]`);
    }
  }
  return parts.join("\n");
}

function hookText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((fragment) =>
      isRecord(fragment) && stringAt(fragment, "text") ? [fragment["text"]] : [],
    )
    .join("\n");
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) ? stringAt(value, "message") : undefined;
}

function changes(value: unknown): TranscriptChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [
      {
        path: stringAt(entry, "path") ?? "unknown",
        kind: stringAt(entry, "kind") ?? "update",
        diff: stringAt(entry, "diff") ?? "",
        raw: entry,
      },
    ];
  });
}

function combinedDiff(value: readonly TranscriptChange[]): string {
  return value
    .map((change) => change.diff)
    .filter(Boolean)
    .join("\n");
}

function planSteps(value: unknown): TranscriptPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const step = stringAt(entry, "step");
    if (!step) return [];
    return [{ step, status: stringAt(entry, "status") ?? "pending" }];
  });
}

function familyFor(type: string): TranscriptFamily {
  switch (type) {
    case "userMessage":
      return "user";
    case "hookPrompt":
      return "hook";
    case "agentMessage":
      return "agent";
    case "plan":
      return "plan";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "fileChange";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "tool";
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "collab";
    case "webSearch":
      return "web";
    case "imageView":
    case "imageGeneration":
      return "media";
    case "sleep":
      return "wait";
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return "system";
    default:
      return "raw";
  }
}

function itemStatus(raw: Record<string, unknown>, lifecycle: "history" | "started" | "completed") {
  const explicit = stringAt(raw, "status");
  if (lifecycle === "completed")
    return explicit && terminalStatus(explicit) ? explicit : "completed";
  if (lifecycle === "started")
    return explicit && terminalStatus(explicit) ? explicit : "inProgress";
  return explicit ?? "completed";
}

function projectItem(
  raw: Record<string, unknown>,
  turnId: string,
  lifecycle: "history" | "started" | "completed",
): TranscriptItem {
  const type = stringAt(raw, "type") ?? "unknown";
  const family = familyFor(type);
  const id = stringAt(raw, "id") ?? `${type}:${turnId}`;
  const status = itemStatus(raw, lifecycle);
  const base: TranscriptItem = { id, turnId, type, family, status, raw };

  switch (type) {
    case "userMessage":
      return { ...base, text: inputText(raw["content"]) };
    case "hookPrompt":
      return { ...base, text: hookText(raw["fragments"]) };
    case "agentMessage":
    case "plan":
      return { ...base, text: stringAt(raw, "text") ?? "" };
    case "reasoning":
      return { ...base, summary: textArray(raw["summary"]), content: textArray(raw["content"]) };
    case "commandExecution":
      return {
        ...base,
        command: stringAt(raw, "command") ?? "",
        cwd: stringAt(raw, "cwd"),
        output: raw["aggregatedOutput"] === null ? "" : stringAt(raw, "aggregatedOutput"),
        exitCode: nullableNumberAt(raw, "exitCode"),
        durationMs: nullableNumberAt(raw, "durationMs"),
      };
    case "fileChange": {
      const projected = changes(raw["changes"]);
      return { ...base, changes: projected, diff: combinedDiff(projected) };
    }
    case "mcpToolCall":
      return {
        ...base,
        toolName: stringAt(raw, "tool") ?? "tool",
        toolServer: stringAt(raw, "server"),
        arguments: raw["arguments"],
        result: raw["result"],
        error: errorText(raw["error"]),
        durationMs: nullableNumberAt(raw, "durationMs"),
      };
    case "dynamicToolCall":
      return {
        ...base,
        toolName: stringAt(raw, "tool") ?? "tool",
        toolServer: stringAt(raw, "namespace"),
        arguments: raw["arguments"],
        result: raw["contentItems"],
        error: raw["success"] === false ? "Tool call failed" : undefined,
        durationMs: nullableNumberAt(raw, "durationMs"),
      };
    case "collabAgentToolCall":
      return {
        ...base,
        toolName: stringAt(raw, "tool") ?? "agent",
        text: stringAt(raw, "prompt"),
        result: raw["agentsStates"],
      };
    case "subAgentActivity":
      return {
        ...base,
        toolName: stringAt(raw, "kind") ?? "agent",
        text: stringAt(raw, "agentPath") ?? stringAt(raw, "agentThreadId"),
      };
    case "webSearch":
      return { ...base, text: stringAt(raw, "query") ?? "", result: raw["results"] };
    case "imageView":
      return { ...base, text: stringAt(raw, "path") ?? "" };
    case "imageGeneration":
      return {
        ...base,
        text: stringAt(raw, "revisedPrompt") ?? stringAt(raw, "savedPath") ?? "Image generation",
        result: raw["result"],
      };
    case "sleep":
      return { ...base, durationMs: numberAt(raw, "durationMs") ?? null };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { ...base, text: stringAt(raw, "review") ?? "Review mode" };
    case "contextCompaction":
      return { ...base, text: "Context compacted" };
    default:
      return base;
  }
}

function turnError(raw: Record<string, unknown>): string | undefined {
  return errorText(raw["error"]);
}

function projectTurn(raw: Record<string, unknown>): TranscriptTurn | null {
  const id = stringAt(raw, "id");
  if (!id) return null;
  const status = stringAt(raw, "status") ?? "completed";
  const values = Array.isArray(raw["items"])
    ? raw["items"].flatMap((value) =>
        isRecord(value)
          ? [projectItem(value, id, terminalStatus(status) ? "history" : "started")]
          : [],
      )
    : [];
  const projectedError = turnError(raw);
  if (projectedError) {
    values.push({
      id: `turn-error:${id}`,
      turnId: id,
      type: "error",
      family: "error",
      status: "failed",
      text: projectedError,
      raw: isRecord(raw["error"]) ? raw["error"] : { message: projectedError },
    });
  }
  return {
    id,
    status,
    ...(projectedError ? { error: projectedError } : {}),
    ...(secondsToMilliseconds(raw["startedAt"]) !== undefined
      ? { startedAtMs: secondsToMilliseconds(raw["startedAt"]) }
      : {}),
    ...(secondsToMilliseconds(raw["completedAt"]) !== undefined
      ? { completedAtMs: secondsToMilliseconds(raw["completedAt"]) }
      : {}),
    ...(nullableNumberAt(raw, "durationMs") !== undefined
      ? { durationMs: nullableNumberAt(raw, "durationMs") }
      : {}),
    items: values,
    raw,
  };
}

export function createTranscript(threadId: string): TranscriptState {
  return { threadId, turns: [], appliedFrameSequences: new Set() };
}

export function hydrateTranscript(threadId: string, value: unknown): TranscriptState {
  const thread = isRecord(value) && isRecord(value["thread"]) ? value["thread"] : value;
  if (!isRecord(thread)) return createTranscript(threadId);
  const turns = Array.isArray(thread["turns"])
    ? thread["turns"].flatMap((turn) => (isRecord(turn) ? [projectTurn(turn)] : [])).filter(Boolean)
    : [];
  return {
    threadId,
    turns: turns as TranscriptTurn[],
    appliedFrameSequences: new Set(),
  };
}

function emptyTurn(id: string): TranscriptTurn {
  return { id, status: "inProgress", items: [], raw: { id, items: [], status: "inProgress" } };
}

function mergeItem(current: TranscriptItem | undefined, incoming: TranscriptItem): TranscriptItem {
  if (!current) return incoming;
  const keepTerminal = terminalStatus(current.status) && !terminalStatus(incoming.status);
  if (keepTerminal) {
    return {
      ...current,
      startedAtMs: current.startedAtMs ?? incoming.startedAtMs,
    };
  }
  return {
    ...current,
    ...incoming,
    status: mergeStatus(current.status, incoming.status),
    progress: incoming.progress ?? current.progress,
    startedAtMs: current.startedAtMs ?? incoming.startedAtMs,
    completedAtMs: incoming.completedAtMs ?? current.completedAtMs,
  };
}

function mergeTurn(current: TranscriptTurn | undefined, incoming: TranscriptTurn): TranscriptTurn {
  if (!current) return incoming;
  const byId = new Map(current.items.map((value) => [value.id, value]));
  const ordered: TranscriptItem[] = [];
  for (const value of incoming.items) {
    ordered.push(mergeItem(byId.get(value.id), value));
    byId.delete(value.id);
  }
  ordered.push(...byId.values());
  return {
    ...current,
    ...incoming,
    status: mergeStatus(current.status, incoming.status),
    items: ordered,
    startedAtMs: current.startedAtMs ?? incoming.startedAtMs,
    completedAtMs: incoming.completedAtMs ?? current.completedAtMs,
  };
}

function replaceTurn(state: TranscriptState, turn: TranscriptTurn): TranscriptState {
  const index = state.turns.findIndex((value) => value.id === turn.id);
  if (index < 0) return { ...state, turns: [...state.turns, turn] };
  const turns = [...state.turns];
  turns[index] = mergeTurn(turns[index], turn);
  return { ...state, turns };
}

function updateTurn(
  state: TranscriptState,
  turnId: string,
  update: (turn: TranscriptTurn) => TranscriptTurn,
): TranscriptState {
  const current = state.turns.find((turn) => turn.id === turnId) ?? emptyTurn(turnId);
  return replaceTurn(state, update(current));
}

function replaceItem(
  state: TranscriptState,
  turnId: string,
  incoming: TranscriptItem,
): TranscriptState {
  return updateTurn(state, turnId, (turn) => {
    const index = turn.items.findIndex((value) => value.id === incoming.id);
    if (index < 0) return { ...turn, items: [...turn.items, incoming] };
    const items = [...turn.items];
    items[index] = mergeItem(items[index], incoming);
    return { ...turn, items };
  });
}

function updateItem(
  state: TranscriptState,
  turnId: string,
  itemId: string,
  placeholder: () => TranscriptItem,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptState {
  return updateTurn(state, turnId, (turn) => {
    const index = turn.items.findIndex((value) => value.id === itemId);
    const current = index < 0 ? placeholder() : turn.items[index]!;
    if (terminalStatus(current.status)) return turn;
    const items = [...turn.items];
    const next = update(current);
    if (index < 0) items.push(next);
    else items[index] = next;
    return { ...turn, items };
  });
}

function placeholder(
  turnId: string,
  itemId: string,
  type: string,
  family: TranscriptFamily,
): TranscriptItem {
  return { id: itemId, turnId, type, family, status: "inProgress", raw: { id: itemId, type } };
}

function indexedDelta(parts: string[] | undefined, index: number, delta: string): string[] {
  const next = [...(parts ?? [])];
  while (next.length <= index) next.push("");
  next[index] = `${next[index] ?? ""}${delta}`;
  return next;
}

function emittedAt(payload: Record<string, unknown>, event: RawFrameEvent): number {
  return numberAt(payload, "emittedAtMs") ?? event.receivedAt;
}

function notificationItem(
  turnId: string,
  id: string,
  type: string,
  family: TranscriptFamily,
  status: string,
  raw: Record<string, unknown>,
  text?: string,
): TranscriptItem {
  return { id, turnId, type, family, status, raw, ...(text ? { text } : {}) };
}

function reduceNotification(
  state: TranscriptState,
  event: RawFrameEvent,
  payload: Record<string, unknown>,
  method: string,
  params: Record<string, unknown>,
): TranscriptState {
  const threadId = stringAt(params, "threadId");
  if (threadId && threadId !== state.threadId) return state;
  const turnId = stringAt(params, "turnId");

  if (method === "turn/started" || method === "turn/completed") {
    const raw = params["turn"];
    if (!isRecord(raw)) return state;
    const turn = projectTurn(raw);
    if (!turn) return state;
    if (method === "turn/completed" && !terminalStatus(turn.status)) turn.status = "completed";
    return replaceTurn(state, turn);
  }

  if ((method === "item/started" || method === "item/completed") && turnId) {
    const raw = params["item"];
    if (!isRecord(raw)) return state;
    const lifecycle = method === "item/started" ? "started" : "completed";
    const projected = projectItem(raw, turnId, lifecycle);
    const timestampKey = lifecycle === "started" ? "startedAtMs" : "completedAtMs";
    const timestamp = numberAt(params, timestampKey) ?? emittedAt(payload, event);
    return replaceItem(state, turnId, { ...projected, [timestampKey]: timestamp });
  }

  const itemId = stringAt(params, "itemId");
  if (method === "item/agentMessage/delta" && turnId && itemId) {
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({ ...placeholder(turnId, itemId, "agentMessage", "agent"), text: "" }),
      (value) => ({ ...value, text: `${value.text ?? ""}${delta}` }),
    );
  }
  if (method === "item/plan/delta" && turnId && itemId) {
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({ ...placeholder(turnId, itemId, "plan", "plan"), text: "" }),
      (value) => ({ ...value, text: `${value.text ?? ""}${delta}` }),
    );
  }
  if (method === "item/reasoning/summaryPartAdded" && turnId && itemId) {
    const index = numberAt(params, "summaryIndex") ?? 0;
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({
        ...placeholder(turnId, itemId, "reasoning", "reasoning"),
        summary: [],
        content: [],
      }),
      (value) => ({ ...value, summary: indexedDelta(value.summary, index, "") }),
    );
  }
  if (method === "item/reasoning/summaryTextDelta" && turnId && itemId) {
    const index = numberAt(params, "summaryIndex") ?? 0;
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({
        ...placeholder(turnId, itemId, "reasoning", "reasoning"),
        summary: [],
        content: [],
      }),
      (value) => ({ ...value, summary: indexedDelta(value.summary, index, delta) }),
    );
  }
  if (method === "item/reasoning/textDelta" && turnId && itemId) {
    const index = numberAt(params, "contentIndex") ?? 0;
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({
        ...placeholder(turnId, itemId, "reasoning", "reasoning"),
        summary: [],
        content: [],
      }),
      (value) => ({ ...value, content: indexedDelta(value.content, index, delta) }),
    );
  }
  if (method === "item/commandExecution/outputDelta" && turnId && itemId) {
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({ ...placeholder(turnId, itemId, "commandExecution", "command"), output: "" }),
      (value) => ({ ...value, output: `${value.output ?? ""}${delta}` }),
    );
  }
  if (method === "item/commandExecution/terminalInteraction" && turnId && itemId) {
    const input = stringAt(params, "stdin") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({ ...placeholder(turnId, itemId, "commandExecution", "command"), output: "" }),
      (value) => ({ ...value, output: `${value.output ?? ""}\n› ${input}` }),
    );
  }
  if (method === "item/fileChange/patchUpdated" && turnId && itemId) {
    const projected = changes(params["changes"]);
    return updateItem(
      state,
      turnId,
      itemId,
      () => placeholder(turnId, itemId, "fileChange", "fileChange"),
      (value) => ({ ...value, changes: projected, diff: combinedDiff(projected) }),
    );
  }
  if (method === "item/fileChange/outputDelta" && turnId && itemId) {
    const delta = stringAt(params, "delta") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => ({ ...placeholder(turnId, itemId, "fileChange", "fileChange"), output: "" }),
      (value) => ({ ...value, output: `${value.output ?? ""}${delta}` }),
    );
  }
  if (method === "item/mcpToolCall/progress" && turnId && itemId) {
    const message = stringAt(params, "message") ?? "";
    return updateItem(
      state,
      turnId,
      itemId,
      () => placeholder(turnId, itemId, "mcpToolCall", "tool"),
      (value) => ({ ...value, progress: [...(value.progress ?? []), message] }),
    );
  }
  if (method === "turn/diff/updated" && turnId) {
    return updateTurn(state, turnId, (turn) => ({ ...turn, diff: stringAt(params, "diff") ?? "" }));
  }
  if (method === "turn/plan/updated" && turnId) {
    const id = `turn-plan:${turnId}`;
    return replaceItem(state, turnId, {
      ...placeholder(turnId, id, "turnPlan", "plan"),
      raw: params,
      text: stringAt(params, "explanation") ?? "",
      explanation: stringAt(params, "explanation") ?? null,
      plan: planSteps(params["plan"]),
    });
  }
  if (method === "error" && turnId) {
    const message = errorText(params["error"]) ?? "Unknown Codex error";
    return replaceItem(
      state,
      turnId,
      notificationItem(
        turnId,
        `error:${turnId}:${emittedAt(payload, event)}`,
        "error",
        "error",
        params["willRetry"] === true ? "inProgress" : "failed",
        params,
        message,
      ),
    );
  }
  if ((method === "warning" || method === "guardianWarning") && threadId) {
    const targetTurn = turnId ?? state.turns.at(-1)?.id ?? "thread";
    return replaceItem(
      state,
      targetTurn,
      notificationItem(
        targetTurn,
        `${method}:${emittedAt(payload, event)}`,
        method,
        "system",
        "completed",
        params,
        stringAt(params, "message") ?? method,
      ),
    );
  }
  if (method === "thread/compacted" && turnId) {
    return replaceItem(
      state,
      turnId,
      notificationItem(
        turnId,
        `context-compaction:${turnId}:${emittedAt(payload, event)}`,
        "contextCompaction",
        "system",
        "completed",
        params,
        "Context compacted",
      ),
    );
  }
  if ((method === "hook/started" || method === "hook/completed") && isRecord(params["run"])) {
    const raw = params["run"];
    const targetTurn = turnId ?? state.turns.at(-1)?.id ?? "thread";
    const runId = stringAt(raw, "id") ?? `${method}:${emittedAt(payload, event)}`;
    return replaceItem(state, targetTurn, {
      ...notificationItem(
        targetTurn,
        `hook-run:${runId}`,
        "hookRun",
        "hook",
        method === "hook/started" ? "inProgress" : (stringAt(raw, "status") ?? "completed"),
        raw,
        stringAt(raw, "eventName") ?? "Hook",
      ),
      durationMs: nullableNumberAt(raw, "durationMs"),
    });
  }
  return state;
}

export function applyTranscriptFrame(
  state: TranscriptState,
  event: RawFrameEvent,
): TranscriptState {
  if (
    event.direction !== "fromAppServer" ||
    event.threadId !== state.threadId ||
    state.appliedFrameSequences.has(event.sequence)
  ) {
    return state;
  }
  const payload = event.payload;
  const method = stringAt(payload, "method");
  const params = isRecord(payload["params"]) ? payload["params"] : null;
  const appliedFrameSequences = new Set(state.appliedFrameSequences);
  appliedFrameSequences.add(event.sequence);
  while (appliedFrameSequences.size > MAX_APPLIED_FRAME_SEQUENCES) {
    const oldest = appliedFrameSequences.values().next().value;
    if (oldest === undefined) break;
    appliedFrameSequences.delete(oldest);
  }
  const marked = { ...state, appliedFrameSequences };
  if (!method || !params) return marked;
  return reduceNotification(marked, event, payload, method, params);
}

export function applyTranscriptFrames(
  state: TranscriptState,
  events: readonly RawFrameEvent[],
): TranscriptState {
  return events.reduce(applyTranscriptFrame, state);
}

export function mergeTranscriptStates(
  historical: TranscriptState,
  live: TranscriptState,
): TranscriptState {
  const liveById = new Map(live.turns.map((turn) => [turn.id, turn]));
  const turns = historical.turns.map((turn) => {
    const liveTurn = liveById.get(turn.id);
    if (!liveTurn) return turn;
    liveById.delete(turn.id);
    // Persisted history defines transcript order; owning frames contribute
    // fields and live-only tail items without moving earlier material.
    return mergeTurn(liveTurn, turn);
  });
  turns.push(...liveById.values());
  const appliedFrameSequences = new Set([
    ...historical.appliedFrameSequences,
    ...live.appliedFrameSequences,
  ]);
  while (appliedFrameSequences.size > MAX_APPLIED_FRAME_SEQUENCES) {
    const oldest = appliedFrameSequences.values().next().value;
    if (oldest === undefined) break;
    appliedFrameSequences.delete(oldest);
  }
  return {
    ...historical,
    turns,
    appliedFrameSequences,
  };
}
