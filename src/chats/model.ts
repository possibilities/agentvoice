import {
  type AgentVoiceThreadIdentity,
  parseVoiceObservation,
  type VoiceLifecycleReason,
  type VoiceLifecycleState,
  type VoiceObservation,
} from "../protocol.ts";

export interface ThreadCard {
  id: string;
  name: string;
  preview: string;
  role: string;
  status: string;
  modelProvider: string;
  cwd: string;
  parentThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  source: unknown;
  raw: Record<string, unknown>;
}

export interface RawFrameEvent {
  kind: "thread";
  sequence: number;
  receivedAt: number;
  direction: "toAppServer" | "fromAppServer";
  owner: "agentvoice" | "client" | "appServer";
  threadId: string | null;
  payload: Record<string, unknown>;
}

export const VOICE_STREAM_ID = "voice-sessions";

export interface VoiceStream {
  kind: "voice";
  id: typeof VOICE_STREAM_ID;
  name: "Voice Sessions";
}

export interface ThreadStream {
  kind: "thread";
  id: string;
  thread: ThreadCard;
}

export type ChatsStream = VoiceStream | ThreadStream;

export interface RawVoiceEvent {
  kind: "voice";
  sequence: number;
  receivedAt: number;
  voiceSessionId: string;
  threadId: string;
  observedAt: number;
  observation: VoiceObservation;
}

export interface VoiceSession {
  id: string;
  threadId: string;
  state: VoiceLifecycleState | "unknown";
  reason?: VoiceLifecycleReason;
  firstObservedAt: number;
  lastObservedAt: number;
  observations: RawVoiceEvent[];
  droppedEvents: number;
}

export type RawStreamEvent = RawFrameEvent | RawVoiceEvent;

export const VOICE_STREAM: VoiceStream = {
  kind: "voice",
  id: VOICE_STREAM_ID,
  name: "Voice Sessions",
};

export const MAX_EVENTS_PER_THREAD = 300;
export const MAX_VOICE_EVENTS_PER_SESSION = 300;
export const MAX_VOICE_SESSIONS = 8;
const MAX_VOICE_STATUS_ROWS_PER_SESSION = 64;
const MAX_PENDING_CORRELATIONS = 1_024;
const CORRELATION_TTL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

export function displayStatus(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "unknown";
  const type = stringAt(value, "type") ?? "unknown";
  const flags = Array.isArray(value["activeFlags"])
    ? value["activeFlags"].filter((flag): flag is string => typeof flag === "string")
    : [];
  return flags.length > 0 ? `${type} / ${flags.join(", ")}` : type;
}

export function displayRole(thread: Record<string, unknown>): string {
  const source = stringAt(thread, "threadSource");
  if (source === "agentvoice-orchestrator") return "orchestrator";
  if (source === "agentvoice-worker") return "worker";
  const agentRole = stringAt(thread, "agentRole")?.trim();
  if (agentRole) return agentRole;
  const sessionSource = thread["source"];
  if (isRecord(sessionSource)) {
    const subagent = sessionSource["subAgent"] ?? sessionSource["subagent"];
    if (isRecord(subagent)) {
      const other = stringAt(subagent, "other")?.trim();
      if (other) return other;
      const spawn = subagent["threadSpawn"] ?? subagent["thread_spawn"];
      if (isRecord(spawn)) {
        const spawnedRole =
          stringAt(spawn, "agentRole")?.trim() ?? stringAt(spawn, "agent_role")?.trim();
        if (spawnedRole) return spawnedRole;
        return "worker";
      }
    }
  }
  if (source === "subagent") return "worker";
  return source ?? "thread";
}

export function threadCard(value: unknown, roleOverride?: string): ThreadCard | null {
  if (!isRecord(value)) return null;
  const id = stringAt(value, "id");
  if (!id) return null;
  const preview = stringAt(value, "preview") ?? "";
  const role = roleOverride?.trim() || displayRole(value);
  const name = stringAt(value, "name")?.trim() || `${role} ${id.slice(0, 8)}`;
  return {
    id,
    name,
    preview,
    role,
    status: displayStatus(value["status"]),
    modelProvider: stringAt(value, "modelProvider") ?? "unknown",
    cwd: stringAt(value, "cwd") ?? "unknown",
    parentThreadId: stringAt(value, "parentThreadId"),
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : 0,
    source: value["source"],
    raw: value,
  };
}

function findThreadId(value: unknown, depth = 0): string | null {
  if (depth > 5 || !isRecord(value)) return null;
  const direct = stringAt(value, "threadId") ?? stringAt(value, "thread_id");
  if (direct) return direct;
  const method = stringAt(value, "method");
  for (const key of ["params", "result", "thread", "turn", "item"]) {
    const child = value[key];
    if (key === "thread" && isRecord(child)) {
      const id = stringAt(child, "id");
      if (id) return id;
    }
    const nested = findThreadId(child, depth + 1);
    if (nested) return nested;
  }
  if (method?.startsWith("thread/") && isRecord(value["result"])) {
    const result = value["result"] as Record<string, unknown>;
    const thread = result["thread"];
    if (isRecord(thread)) return stringAt(thread, "id");
  }
  return null;
}

function wireId(frame: Record<string, unknown>): number | string | null {
  const id = frame["id"];
  return typeof id === "number" || typeof id === "string" ? id : null;
}

export class ChatsModel {
  readonly threads = new Map<string, ThreadCard>();
  readonly events = new Map<string, RawFrameEvent[]>();
  readonly droppedEvents = new Map<string, number>();
  readonly voiceSessions = new Map<string, VoiceSession>();
  private readonly threadByWireId = new Map<string, { threadId: string; expiresAt: number }>();
  private readonly agentVoiceRoles = new Map<string, AgentVoiceThreadIdentity["role"]>();
  private sequence = 0;

  replaceAgentVoiceThreadIdentities(values: unknown): void {
    this.agentVoiceRoles.clear();
    if (Array.isArray(values)) {
      for (const value of values) {
        if (!isRecord(value)) continue;
        const threadId = stringAt(value, "threadId");
        const role = stringAt(value, "role");
        if (threadId && (role === "orchestrator" || role === "worker")) {
          this.agentVoiceRoles.set(threadId, role);
        }
      }
    }
    for (const [id, current] of this.threads) {
      const updated = threadCard(current.raw, this.agentVoiceRoles.get(id));
      if (updated) this.threads.set(id, updated);
    }
  }

  replaceThreads(values: unknown[]): ThreadCard[] {
    const next = new Map<string, ThreadCard>();
    for (const value of values) {
      const id = isRecord(value) ? stringAt(value, "id") : null;
      const card = threadCard(value, id ? this.agentVoiceRoles.get(id) : undefined);
      if (card) next.set(card.id, card);
    }
    this.threads.clear();
    for (const [id, card] of next) this.threads.set(id, card);
    for (const id of this.events.keys()) {
      if (next.has(id)) continue;
      this.events.delete(id);
      this.droppedEvents.delete(id);
    }
    return this.sortedThreads;
  }

  get sortedThreads(): ThreadCard[] {
    return [...this.threads.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }

  get sortedStreams(): ChatsStream[] {
    return [
      VOICE_STREAM,
      ...this.sortedThreads.map(
        (thread): ThreadStream => ({
          kind: "thread",
          id: thread.id,
          thread,
        }),
      ),
    ];
  }

  eventsFor(stream: ChatsStream): readonly RawStreamEvent[] {
    return stream.kind === "voice"
      ? this.voiceSessionList.flatMap((session) => session.observations)
      : (this.events.get(stream.id) ?? []);
  }

  droppedEventsFor(stream: ChatsStream): number {
    return stream.kind === "voice"
      ? this.voiceSessionList.reduce((total, session) => total + session.droppedEvents, 0)
      : (this.droppedEvents.get(stream.id) ?? 0);
  }

  get voiceSessionList(): VoiceSession[] {
    return [...this.voiceSessions.values()].sort(
      (a, b) =>
        a.firstObservedAt - b.firstObservedAt ||
        a.lastObservedAt - b.lastObservedAt ||
        a.id.localeCompare(b.id),
    );
  }

  recordVoiceObservation(value: unknown, receivedAt = Date.now()): RawVoiceEvent | null {
    const observation = parseVoiceObservation(value);
    if (!observation) return null;
    const event: RawVoiceEvent = {
      kind: "voice",
      sequence: ++this.sequence,
      receivedAt,
      voiceSessionId: observation.voiceSessionId,
      threadId: observation.threadId,
      observedAt: observation.observedAt,
      observation,
    };

    const existing = this.voiceSessions.get(observation.voiceSessionId);
    const session: VoiceSession = existing ?? {
      id: observation.voiceSessionId,
      threadId: observation.threadId,
      state: "unknown",
      firstObservedAt: observation.observedAt,
      lastObservedAt: observation.observedAt,
      observations: [],
      droppedEvents: 0,
    };
    session.threadId = observation.threadId;
    session.firstObservedAt = Math.min(session.firstObservedAt, observation.observedAt);
    session.lastObservedAt = Math.max(session.lastObservedAt, observation.observedAt);
    if (observation.kind === "lifecycle") {
      session.state = observation.state;
      if (observation.reason) session.reason = observation.reason;
      else delete session.reason;
    }
    session.observations.push(event);
    session.observations.sort(
      (left, right) => left.observedAt - right.observedAt || left.sequence - right.sequence,
    );
    this.pruneVoiceSession(session);

    // Map order is the live recency order used to retain only the latest sessions.
    if (existing) this.voiceSessions.delete(session.id);
    this.voiceSessions.set(session.id, session);
    while (this.voiceSessions.size > MAX_VOICE_SESSIONS) {
      const oldest = this.voiceSessions.keys().next().value;
      if (oldest === undefined) break;
      this.voiceSessions.delete(oldest);
    }
    return event;
  }

  private pruneVoiceSession(session: VoiceSession): void {
    let eventRows = session.observations.filter(
      (event) => event.observation.kind === "event",
    ).length;
    let statusRows = session.observations.length - eventRows;
    if (
      eventRows <= MAX_VOICE_EVENTS_PER_SESSION &&
      statusRows <= MAX_VOICE_STATUS_ROWS_PER_SESSION
    )
      return;
    session.observations = session.observations.filter((event) => {
      if (event.observation.kind === "event" && eventRows > MAX_VOICE_EVENTS_PER_SESSION) {
        eventRows -= 1;
        session.droppedEvents += 1;
        return false;
      }
      if (event.observation.kind !== "event" && statusRows > MAX_VOICE_STATUS_ROWS_PER_SESSION) {
        statusRows -= 1;
        return false;
      }
      return true;
    });
  }

  recordEnvelope(value: unknown, receivedAt = Date.now()): RawFrameEvent | null {
    if (!isRecord(value)) return null;
    const direction = value["direction"];
    const owner = value["owner"];
    const payload = value["payload"];
    if (
      (direction !== "toAppServer" && direction !== "fromAppServer") ||
      (owner !== "agentvoice" && owner !== "client" && owner !== "appServer") ||
      !isRecord(payload)
    ) {
      return null;
    }

    this.pruneCorrelations(receivedAt);
    const id = wireId(payload);
    const correlationKey = id === null ? null : `${owner}:${typeof id}:${String(id)}`;
    let threadId = findThreadId(payload);
    if (direction === "toAppServer" && correlationKey !== null && threadId) {
      if (this.threadByWireId.size >= MAX_PENDING_CORRELATIONS) {
        const oldest = this.threadByWireId.keys().next().value;
        if (oldest !== undefined) this.threadByWireId.delete(oldest);
      }
      this.threadByWireId.set(correlationKey, {
        threadId,
        expiresAt: receivedAt + CORRELATION_TTL_MS,
      });
    } else if (direction === "fromAppServer" && correlationKey !== null) {
      threadId ??= this.threadByWireId.get(correlationKey)?.threadId ?? null;
      if (payload["method"] === undefined) this.threadByWireId.delete(correlationKey);
    }
    if (!threadId) return null;

    const event: RawFrameEvent = {
      kind: "thread",
      sequence: ++this.sequence,
      receivedAt,
      direction,
      owner,
      threadId,
      payload,
    };
    const events = this.events.get(threadId) ?? [];
    events.push(event);
    if (events.length > MAX_EVENTS_PER_THREAD) {
      const excess = events.length - MAX_EVENTS_PER_THREAD;
      events.splice(0, excess);
      this.droppedEvents.set(threadId, (this.droppedEvents.get(threadId) ?? 0) + excess);
    }
    this.events.set(threadId, events);
    this.updateThreadMetadata(payload);
    return event;
  }

  private pruneCorrelations(now: number): void {
    for (const [id, correlation] of this.threadByWireId) {
      if (correlation.expiresAt > now) continue;
      this.threadByWireId.delete(id);
    }
  }

  private updateThreadMetadata(payload: Record<string, unknown>): void {
    const method = stringAt(payload, "method");
    const params = isRecord(payload["params"]) ? payload["params"] : null;
    if (!params) return;

    if (method === "thread/started") {
      const updated = threadCard(params["thread"]);
      if (updated && this.threads.has(updated.id)) this.threads.set(updated.id, updated);
      return;
    }

    const threadId = stringAt(params, "threadId");
    const current = threadId ? this.threads.get(threadId) : null;
    if (!threadId || !current) return;
    if (method === "thread/status/changed") {
      const raw = { ...current.raw, status: params["status"] };
      const updated = threadCard(raw);
      if (updated) this.threads.set(threadId, updated);
    } else if (method === "thread/name/updated") {
      const name = stringAt(params, "threadName");
      const raw = { ...current.raw, name };
      const updated = threadCard(raw);
      if (updated) this.threads.set(threadId, updated);
    }
  }
}
