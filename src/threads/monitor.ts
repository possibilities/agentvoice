import { discoverControllerStatus } from "../control/discovery.ts";
import {
  EVENT_PROTOCOL_VERSION,
  type ThreadSnapshot,
  type ThreadView,
} from "../events/contract.ts";
import { threadDetailsSchema } from "../events/conversation.ts";
import { eventSnapshotSchema } from "../events/schema.ts";
import { eventSocketPath } from "../events/socket.ts";
import { discoverServer } from "../frontend/discovery.ts";
import { ControlSocket, SocketFailure } from "../ipc/control-client.ts";

export type ThreadRow = ThreadView & {
  model?: string | null;
  effort?: string | null;
  nickname?: string | null;
};
export type ThreadMonitor = {
  phase: string;
  workspace?: string;
  inventory: ThreadSnapshot["inventory"];
  threads: ThreadRow[];
  missingSettings: number;
};
type Reader = Pick<ControlSocket, "request">;

/** One bounded observation. Never resume a thread or read its conversation history. */
export async function readThreadMonitor(
  client: Reader,
  expected: { instanceId: string; workspace: string; threadId: string },
  budgetMs = 4_000,
): Promise<ThreadMonitor> {
  const before = eventSnapshotSchema.parse(await client.request("state.get", {}));
  if (
    before.instanceId !== expected.instanceId ||
    before.runtime.workspace !== expected.workspace ||
    before.runtime.mainThreadId !== expected.threadId
  )
    throw new Error("AgentVoice call changed during discovery; retry");
  const settings = new Map<string, Pick<ThreadRow, "model" | "effort" | "nickname">>();
  let next = 0;
  const deadline = Date.now() + budgetMs;
  await Promise.all(
    Array.from({ length: Math.min(4, before.threads.length) }, async () => {
      while (Date.now() < deadline) {
        const thread = before.threads[next++];
        if (!thread) return;
        try {
          const raw = await client.request("conversation.thread.get", {
            expectedInstanceId: before.instanceId,
            expectedGeneration: before.generation,
            rootThreadId: expected.threadId,
            threadId: thread.id,
          });
          if (!raw || typeof raw !== "object") continue;
          const result = raw as Record<string, unknown>;
          if (
            result["method"] !== "conversation.thread.get" ||
            result["instanceId"] !== before.instanceId ||
            result["generation"] !== before.generation ||
            result["rootThreadId"] !== expected.threadId ||
            result["threadId"] !== thread.id
          )
            continue;
          const parsed = threadDetailsSchema.safeParse(result["data"]);
          if (!parsed.success || parsed.data.id !== thread.id) continue;
          settings.set(thread.id, {
            model: parsed.data.model,
            effort: parsed.data.reasoningEffort,
            nickname: parsed.data.agentNickname,
          });
        } catch (error) {
          if (
            error instanceof SocketFailure &&
            ["stale_generation", "instance_mismatch"].includes(error.code ?? "")
          )
            throw error;
          // Closed/unavailable threads stay visible with unknown settings until the next inventory cut.
        }
      }
    }),
  );
  const after = eventSnapshotSchema.parse(await client.request("state.get", {}));
  if (
    after.instanceId !== before.instanceId ||
    after.generation !== before.generation ||
    after.runtime.mainThreadId !== before.runtime.mainThreadId ||
    after.runtime.workspace !== before.runtime.workspace
  )
    throw new Error("AgentVoice runtime changed during observation; retry");
  const threads = after.threads.map((thread) => ({ ...thread, ...settings.get(thread.id) }));
  return {
    phase: after.runtime.phase,
    workspace: after.runtime.workspace,
    inventory: after.inventory,
    threads,
    missingSettings: threads.filter((thread) => thread.model == null || thread.effort == null)
      .length,
  };
}

export async function discoverThreadMonitor(
  stateDir: string,
  workspace?: string,
  threadId?: string,
) {
  const server = await discoverServer(stateDir, workspace);
  const empty = (phase: string): ThreadMonitor => ({
    phase,
    workspace,
    inventory: "unavailable",
    threads: [],
    missingSettings: 0,
  });
  if (workspace === undefined) {
    if (!server) return empty("offline");
    if (!server.busy) return empty("waiting");
    if (!server.workspace || !server.threadId) return empty("starting");
    workspace = server.workspace;
    threadId ??= server.threadId;
  }
  let live: Awaited<ReturnType<typeof discoverControllerStatus>>;
  try {
    live = await discoverControllerStatus(stateDir, workspace, threadId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no live AgentVoice controller"))
      return empty(server?.busy ? "starting" : server ? "waiting" : "offline");
    throw error;
  }
  const client = await ControlSocket.connect(
    eventSocketPath(stateDir, live.descriptor.instanceId),
    EVENT_PROTOCOL_VERSION,
  );
  try {
    return await readThreadMonitor(client, {
      instanceId: live.descriptor.instanceId,
      workspace,
      threadId: live.status.threadId,
    });
  } finally {
    client.close();
  }
}

// Native names and model strings are display data, never terminal control sequences.
function cell(value: string, width: number): string {
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  const points = [...text];
  return points.length > width ? `${points.slice(0, width - 1).join("")}…` : text;
}
function turnState(thread: ThreadRow): string {
  if (thread.activeFlags.includes("waitingOnApproval")) return "waiting approval";
  if (thread.activeFlags.includes("waitingOnUserInput")) return "waiting input";
  if (thread.status === "systemError") return "system error";
  if (thread.status === "active") return "working";
  if (thread.turn?.status === "inProgress") return "in progress";
  if (thread.turn) return `${thread.status}: ${thread.turn.status}`;
  return thread.status;
}

export function formatThreadMonitor(snapshot: ThreadMonitor): string {
  const lines = [
    `AgentVoice: ${cell(snapshot.phase, 40)} | ${snapshot.threads.length} loaded threads`,
  ];
  if (snapshot.workspace) lines.push(`Workspace: ${cell(snapshot.workspace, 200)}`);
  if (!snapshot.threads.length) {
    lines.push(
      snapshot.phase === "waiting" || snapshot.phase === "offline"
        ? "No active call."
        : `Thread inventory: ${snapshot.inventory}.`,
    );
    return `${lines.join("\n")}\n`;
  }
  if (snapshot.inventory !== "ready")
    lines.push(`Thread inventory: ${snapshot.inventory} (partial).`);
  if (snapshot.missingSettings)
    lines.push("? = setting unset or unavailable; model/effort are current thread settings.");
  const row = (name: string, model: string, effort: string, turn: string, id: string) =>
    `${cell(name, 44).padEnd(44)}  ${cell(model, 24).padEnd(24)}  ${cell(effort, 8).padEnd(8)}  ${cell(turn, 22).padEnd(22)}  ${id}`;
  lines.push(row("THREAD", "MODEL", "EFFORT", "TURN", "ID"));
  const threads = [...snapshot.threads].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(threads.map((thread) => thread.id));
  const visited = new Set<string>();
  function visit(thread: ThreadRow, depth: number, suffix = "") {
    const prefix = "  ".repeat(Math.min(depth, 8)) + (depth > 8 ? `[depth ${depth}] ` : "");
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    lines.push(
      row(
        `${prefix}${thread.name || thread.nickname || "(unnamed)"}`,
        thread.model ?? "?",
        thread.effort ?? "?",
        turnState(thread),
        `${thread.id}${suffix}`,
      ),
    );
    for (const child of threads.filter((child) => child.parentThreadId === thread.id))
      visit(child, depth + 1);
  }
  for (const thread of threads.filter(
    (thread) => !thread.parentThreadId || !ids.has(thread.parentThreadId),
  ))
    visit(thread, 0, thread.parentThreadId ? ` [parent ${thread.parentThreadId} not loaded]` : "");
  // Malformed or incomplete ancestry must not hide a loaded thread or loop forever.
  for (const thread of threads)
    if (!visited.has(thread.id)) visit(thread, 0, " [unresolved ancestry]");
  return `${lines.join("\n")}\n`;
}
