import { discoverControllerStatus } from "../control/discovery.ts";
import {
  EVENT_PROTOCOL_VERSION,
  MAX_THREADS,
  type ThreadSnapshot,
  type ThreadView,
} from "../events/contract.ts";
import { threadDetailsSchema } from "../events/conversation.ts";
import { eventSnapshotSchema } from "../events/schema.ts";
import { eventSocketPath } from "../events/socket.ts";
import { discoverServer } from "../frontend/discovery.ts";
import { ControlSocket, SocketFailure } from "../ipc/control-client.ts";

export type ParentageSource = "live_inventory" | "native_history";
export type NativeParentage =
  | { state: "root"; sources: ParentageSource[] }
  | { state: "verified"; parentThreadId: string; sources: ParentageSource[] }
  | { state: "missing"; reason: "not_reported"; sources: ParentageSource[] }
  | { state: "conflict"; parentThreadIds: string[]; sources: ParentageSource[] };
export type CollaborationIdentity =
  | { state: "root"; sources: ParentageSource[] }
  | { state: "verified"; path: string; sources: ParentageSource[] }
  | {
      state: "missing";
      reason: "not_reported" | "malformed";
      sources: ParentageSource[];
    }
  | { state: "conflict"; paths: string[]; sources: ParentageSource[] };
export type ThreadRow = ThreadView & {
  model?: string | null;
  effort?: string | null;
  nickname?: string | null;
  parentage?: NativeParentage;
  collaborationIdentity?: CollaborationIdentity;
};
export type ThreadMonitor = {
  instanceId?: string;
  generation?: number;
  sequence?: number;
  rootThreadId?: string;
  phase: string;
  workspace?: string;
  /** Stable only for the exact native root revalidated by this AgentVoice workspace. */
  nativeSessionId?: string;
  inventory: ThreadSnapshot["inventory"];
  historyCoverage?: "complete" | "partial" | "unavailable";
  threads: ThreadRow[];
  missingSettings: number;
};
type Reader = Pick<ControlSocket, "request">;

type ObservedRow = Omit<ThreadRow, "parentage" | "collaborationIdentity"> & {
  source: ParentageSource;
  collaborationIdentity?:
    | { state: "verified"; path: string }
    | { state: "missing"; reason: "not_reported" | "malformed" };
};

type ThreadEnrichment = Pick<ThreadRow, "model" | "effort" | "nickname"> & {
  parentThreadId?: string | null;
  collaborationIdentity?: ObservedRow["collaborationIdentity"];
};

const ENRICHMENT_ATTEMPTS = 4;

function enrichmentComplete(
  threadId: string,
  rootThreadId: string,
  enrichment: ThreadEnrichment | undefined,
): boolean {
  if (!enrichment || enrichment.model == null || enrichment.effort == null) return false;
  if (threadId === rootThreadId) return true;
  return (
    enrichment.collaborationIdentity?.state === "verified" ||
    (enrichment.collaborationIdentity?.state === "missing" &&
      enrichment.collaborationIdentity.reason === "malformed")
  );
}

async function enrichThreads(
  client: Reader,
  snapshot: ThreadSnapshot,
  rootThreadId: string,
  settings: Map<string, ThreadEnrichment>,
  deadline: number,
): Promise<void> {
  const pending = snapshot.threads.filter(
    (thread) => !enrichmentComplete(thread.id, rootThreadId, settings.get(thread.id)),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (Date.now() < deadline) {
        const thread = pending[next++];
        if (!thread) return;
        for (let attempt = 0; attempt < ENRICHMENT_ATTEMPTS && Date.now() < deadline; attempt++) {
          try {
            const raw = await client.request("conversation.thread.get", {
              expectedInstanceId: snapshot.instanceId,
              expectedGeneration: snapshot.generation,
              rootThreadId,
              threadId: thread.id,
            });
            if (!raw || typeof raw !== "object") continue;
            const result = raw as Record<string, unknown>;
            if (
              result["method"] !== "conversation.thread.get" ||
              result["instanceId"] !== snapshot.instanceId ||
              result["generation"] !== snapshot.generation ||
              result["rootThreadId"] !== rootThreadId ||
              result["threadId"] !== thread.id
            )
              continue;
            const parsed = threadDetailsSchema.safeParse(result["data"]);
            if (!parsed.success || parsed.data.id !== thread.id) continue;
            const latest = {
              parentThreadId: parsed.data.parentThreadId,
              model: parsed.data.model,
              effort: parsed.data.reasoningEffort,
              nickname: parsed.data.agentNickname,
              collaborationIdentity: parsed.data.collaborationIdentity,
            };
            settings.set(thread.id, latest);
            if (enrichmentComplete(thread.id, rootThreadId, latest)) break;
          } catch (error) {
            if (
              error instanceof SocketFailure &&
              ["stale_generation", "instance_mismatch"].includes(error.code ?? "")
            )
              throw error;
          }
          if (attempt + 1 < ENRICHMENT_ATTEMPTS && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    }),
  );
}

function rowFromHistory(value: unknown): ObservedRow {
  const row = threadDetailsSchema.parse(value);
  return {
    id: row.id,
    parentThreadId: row.parentThreadId ?? null,
    name: row.name ?? null,
    status: row.status.type,
    activeFlags: row.status.activeFlags ?? [],
    turn: null,
    model: row.model,
    effort: row.reasoningEffort,
    nickname: row.agentNickname,
    collaborationIdentity: row.collaborationIdentity,
    source: "native_history",
  };
}

async function readNativeDescendants(
  client: Reader,
  identity: { instanceId: string; generation: number; rootThreadId: string },
  deadline: number,
): Promise<{
  rows: ObservedRow[];
  coverage: NonNullable<ThreadMonitor["historyCoverage"]>;
}> {
  const rows: ObservedRow[] = [];
  let complete = true;
  let succeeded = false;
  let revision: number | undefined;
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || rows.length >= MAX_THREADS) {
        complete = false;
        break;
      }
      try {
        const result = (await client.request("conversation.threads.list", {
          expectedInstanceId: identity.instanceId,
          expectedGeneration: identity.generation,
          rootThreadId: identity.rootThreadId,
          archived,
          limit: Math.min(25, MAX_THREADS - rows.length),
          ...(cursor ? { cursor } : {}),
        })) as Record<string, unknown>;
        if (
          result["method"] !== "conversation.threads.list" ||
          result["instanceId"] !== identity.instanceId ||
          result["generation"] !== identity.generation ||
          result["rootThreadId"] !== identity.rootThreadId ||
          !Array.isArray(result["data"]) ||
          !Number.isSafeInteger(result["revisionBefore"]) ||
          !Number.isSafeInteger(result["revisionAfter"]) ||
          typeof result["changedDuringRead"] !== "boolean"
        )
          throw new Error("invalid native descendant page");
        succeeded = true;
        const revisionBefore = result["revisionBefore"] as number;
        const revisionAfter = result["revisionAfter"] as number;
        if (
          result["changedDuringRead"] ||
          revisionBefore !== revisionAfter ||
          (revision !== undefined && revisionBefore !== revision)
        )
          complete = false;
        revision = revisionAfter;
        for (const value of result["data"]) rows.push(rowFromHistory(value));
        const next = result["nextCursor"];
        if (next !== null && (typeof next !== "string" || !next || cursors.has(next)))
          throw new Error("invalid native descendant cursor");
        cursor = typeof next === "string" ? next : undefined;
        if (cursor) cursors.add(cursor);
      } catch {
        complete = false;
        break;
      }
    } while (cursor);
  }
  return {
    rows,
    coverage: complete ? "complete" : succeeded ? "partial" : "unavailable",
  };
}

function mergeRows(rootThreadId: string, rows: ObservedRow[]): ThreadRow[] {
  const grouped = new Map<string, ObservedRow[]>();
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
  return [...grouped.entries()].map(([id, observed]) => {
    const live = observed.find((row) => row.source === "live_inventory");
    const base = live ?? observed[0]!;
    const parents = [
      ...new Set(
        observed.map((row) => row.parentThreadId).filter((parent): parent is string => !!parent),
      ),
    ].sort();
    const sourcesFor = (parent?: string) =>
      [
        ...new Set(
          observed
            .filter((row) =>
              parent === undefined ? !row.parentThreadId : row.parentThreadId === parent,
            )
            .map((row) => row.source),
        ),
      ].sort() as ParentageSource[];
    let parentage: NativeParentage;
    if (id === rootThreadId && parents.length === 0)
      parentage = { state: "root", sources: sourcesFor() };
    else if (parents.length === 1)
      parentage = {
        state: "verified",
        parentThreadId: parents[0]!,
        sources: sourcesFor(parents[0]!),
      };
    else if (parents.length === 0)
      parentage = { state: "missing", reason: "not_reported", sources: sourcesFor() };
    else
      parentage = {
        state: "conflict",
        parentThreadIds: parents,
        sources: [...new Set(parents.flatMap((parent) => sourcesFor(parent)))].sort(),
      };
    const identityEvidence = observed.flatMap((row) =>
      row.collaborationIdentity ? [{ ...row.collaborationIdentity, source: row.source }] : [],
    );
    const paths = [
      ...new Set(
        identityEvidence.flatMap((identity) =>
          identity.state === "verified" ? [identity.path] : [],
        ),
      ),
    ].sort();
    const identitySources = (matching = identityEvidence) =>
      [
        ...new Set((matching.length ? matching : observed).map((row) => row.source)),
      ].sort() as ParentageSource[];
    let collaborationIdentity: CollaborationIdentity;
    if (id === rootThreadId) collaborationIdentity = { state: "root", sources: identitySources() };
    else if (paths.length > 1)
      collaborationIdentity = {
        state: "conflict",
        paths,
        sources: identitySources(
          identityEvidence.filter((identity) => identity.state === "verified"),
        ),
      };
    else if (
      identityEvidence.some(
        (identity) => identity.state === "missing" && identity.reason === "malformed",
      )
    )
      collaborationIdentity = {
        state: "missing",
        reason: "malformed",
        sources: identitySources(
          identityEvidence.filter(
            (identity) => identity.state === "missing" && identity.reason === "malformed",
          ),
        ),
      };
    else if (paths.length === 1)
      collaborationIdentity = {
        state: "verified",
        path: paths[0]!,
        sources: identitySources(
          identityEvidence.filter(
            (identity) => identity.state === "verified" && identity.path === paths[0],
          ),
        ),
      };
    else
      collaborationIdentity = {
        state: "missing",
        reason: "not_reported",
        sources: identitySources(),
      };
    return {
      id,
      parentThreadId: parentage.state === "verified" ? parentage.parentThreadId : null,
      name: base.name,
      status: live?.status ?? "notLoaded",
      activeFlags: live?.activeFlags ?? [],
      turn: live?.turn ?? null,
      model: live?.model ?? base.model,
      effort: live?.effort ?? base.effort,
      nickname: live?.nickname ?? base.nickname,
      parentage,
      collaborationIdentity,
    };
  });
}

/** One bounded observation. Reads metadata only; never resumes a thread or reads item bodies. */
export async function readThreadMonitor(
  client: Reader,
  expected: { instanceId: string; workspace: string; threadId: string },
  budgetMs = 12_000,
): Promise<ThreadMonitor> {
  const before = eventSnapshotSchema.parse(await client.request("state.get", {}));
  if (
    before.instanceId !== expected.instanceId ||
    before.runtime.workspace !== expected.workspace ||
    before.runtime.mainThreadId !== expected.threadId
  )
    throw new Error("AgentVoice call changed during discovery; retry");
  const settings = new Map<string, ThreadEnrichment>();
  const settingsBudget = Math.min(4_000, Math.max(0, Math.floor(budgetMs / 3)));
  const deadline = Date.now() + settingsBudget;
  await enrichThreads(client, before, expected.threadId, settings, deadline);
  const after = eventSnapshotSchema.parse(await client.request("state.get", {}));
  if (
    after.instanceId !== before.instanceId ||
    after.generation !== before.generation ||
    after.runtime.mainThreadId !== before.runtime.mainThreadId ||
    after.runtime.workspace !== before.runtime.workspace
  )
    throw new Error("AgentVoice runtime changed during observation; retry");
  // A worker may enter the live inventory while the first metadata pass is in
  // flight. Enrich that exact row before publishing it so normal native startup
  // does not become a transient missing-identity observation for independent UIs.
  await enrichThreads(client, after, expected.threadId, settings, deadline);
  const history =
    budgetMs > 0
      ? await readNativeDescendants(
          client,
          {
            instanceId: after.instanceId,
            generation: after.generation,
            rootThreadId: after.runtime.mainThreadId,
          },
          Date.now() + Math.max(0, budgetMs - settingsBudget),
        )
      : { rows: [], coverage: "unavailable" as const };
  const final =
    budgetMs > 0 ? eventSnapshotSchema.parse(await client.request("state.get", {})) : after;
  if (
    final.instanceId !== before.instanceId ||
    final.generation !== before.generation ||
    final.runtime.mainThreadId !== before.runtime.mainThreadId ||
    final.runtime.workspace !== before.runtime.workspace
  )
    throw new Error("AgentVoice runtime changed during native history observation; retry");
  // Cover the smaller race where a worker appears during persisted-history
  // discovery. This final bounded pass is only for rows not already complete.
  if (budgetMs > 0)
    await enrichThreads(
      client,
      final,
      expected.threadId,
      settings,
      Date.now() + Math.min(500, settingsBudget),
    );
  const liveRows = final.threads.map((thread) => {
    const enrichment = settings.get(thread.id);
    return {
      ...thread,
      ...enrichment,
      parentThreadId: enrichment?.parentThreadId ?? thread.parentThreadId,
      source: "live_inventory" as const,
    };
  });
  let historyRows = history.rows;
  let historyCoverage = history.coverage;
  if (new Set([...liveRows, ...historyRows].map((row) => row.id)).size > MAX_THREADS) {
    const liveIds = new Set(liveRows.map((row) => row.id));
    const overlapping = historyRows.filter((row) => liveIds.has(row.id));
    const historyOnly = historyRows
      .filter((row) => !liveIds.has(row.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, Math.max(0, MAX_THREADS - liveIds.size));
    // Corroborating history for a live row costs no additional exported row.
    historyRows = [...overlapping, ...historyOnly];
    historyCoverage = "partial";
  }
  const threads = mergeRows(after.runtime.mainThreadId, [...liveRows, ...historyRows]);
  return {
    instanceId: final.instanceId,
    generation: final.generation,
    sequence: final.sequence,
    rootThreadId: final.runtime.mainThreadId,
    phase: final.runtime.phase,
    workspace: final.runtime.workspace,
    nativeSessionId: final.runtime.mainThreadId,
    inventory: final.inventory,
    historyCoverage,
    threads,
    missingSettings: threads.filter((thread) => thread.model == null || thread.effort == null)
      .length,
  };
}

/** Read-only status compatibility; never used for mutation discovery. */
export async function discoverObservedController(
  stateDir: string,
  workspace: string,
  threadId?: string,
  discover = discoverControllerStatus,
) {
  const matches = new Map<string, Awaited<ReturnType<typeof discoverControllerStatus>>>();
  for (const version of [undefined, 8, 7, 6, 5] as const) {
    try {
      const candidate = await discover(stateDir, workspace, threadId, version);
      const status = candidate.status;
      const identity = JSON.stringify([
        status.instanceId,
        status.generation,
        status.workspace,
        status.threadId,
      ]);
      matches.set(identity, candidate);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("no live AgentVoice controller"))
        throw error;
    }
  }
  if (matches.size > 1)
    throw new Error("ambiguous AgentVoice controllers across compatible read-only protocols");
  const match = matches.values().next().value;
  if (!match) throw new Error("no live AgentVoice controller");
  return match;
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
    historyCoverage: "unavailable",
    threads: [],
    missingSettings: 0,
  });
  if (workspace === undefined) {
    if (!server) return empty("offline");
    if (!server.busy && !server.threadId) return empty("waiting");
    if (!server.workspace || !server.threadId) return empty("starting");
    workspace = server.workspace;
    threadId ??= server.threadId;
  }
  let live: Awaited<ReturnType<typeof discoverControllerStatus>>;
  try {
    live = await discoverObservedController(stateDir, workspace, threadId);
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
  if (snapshot.historyCoverage && snapshot.historyCoverage !== "complete")
    lines.push(`Native parentage history: ${snapshot.historyCoverage}.`);
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
