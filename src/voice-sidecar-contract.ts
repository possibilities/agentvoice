import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventRecord } from "./events.ts";

export const VOICE_SIDECAR_WIRE_CONTRACT_VERSION = 1 as const;
export const VOICE_SIDECAR_WIRE_CONTRACT_ID = "agentvoice-codex-fx-v1" as const;
export const VOICE_SIDECAR_SOURCE_EVENTS_SHA256 =
  "0d120e76ec8ee980827f978af72d5b365cd6a61eb4730736ccd9bb3eaf9c93d1" as const;
export const VOICE_SIDECAR_WIRE_CONTRACT_PATH = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "codex-voice-sidecar",
  "consumed-wire-contract-v1.json",
);

export interface WireMessageRecord {
  direction: "in" | "out";
  message: Record<string, unknown>;
}

interface CountedMethod {
  method: string;
  count: number;
}

interface CountedRequest extends CountedMethod {
  responseCount: number;
}

export interface ConsumedWireContractProjection {
  clientNotifications: CountedMethod[];
  requests: CountedRequest[];
  serverNotifications: CountedMethod[];
  threadStart: {
    approvalPolicy: unknown;
    sandbox: unknown;
    model: unknown;
    ephemeral: unknown;
    reasoningEffort: unknown;
  };
  realtimeStart: {
    version: unknown;
    voice: unknown;
    outputModality: unknown;
    includeStartupContext: unknown;
    clientManagedHandoffs: unknown;
    delegationAckFiller: unknown;
    modelOverride: "absent" | "present";
    transport: unknown;
  };
  handoffRequests: {
    count: number;
    type: unknown;
    requiredFields: string[];
  };
  requestedClose: {
    requestCount: number;
    notificationCount: number;
    reason: unknown;
  };
}

interface WireContractFixture {
  schemaVersion: 1;
  id: typeof VOICE_SIDECAR_WIRE_CONTRACT_ID;
  derivedFrom: { artifact: string; eventsSha256: string };
  consumedProjection: ConsumedWireContractProjection;
}

const REQUEST_METHODS = [
  "initialize",
  "thread/realtime/listVoices",
  "thread/start",
  "thread/realtime/start",
  "thread/realtime/appendSpeech",
  "thread/realtime/stop",
  "thread/delete",
] as const;
const SERVER_NOTIFICATION_METHODS = [
  "thread/realtime/started",
  "thread/realtime/sdp",
  "thread/realtime/itemAdded",
  "thread/realtime/closed",
] as const;
const OPTIONAL_SERVER_NOTIFICATION_METHODS = [
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
] as const;
const REQUEST_METHOD_SET = new Set<string>(REQUEST_METHODS);
const SERVER_NOTIFICATION_METHOD_SET = new Set<string>([
  ...SERVER_NOTIFICATION_METHODS,
  ...OPTIONAL_SERVER_NOTIFICATION_METHODS,
]);
const HANDOFF_REQUIRED_FIELDS = [
  "active_transcript",
  "handoff_id",
  "input_transcript",
  "item_id",
] as const;

export class VoiceSidecarWireContractError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`voice-sidecar wire contract failed:\n- ${issues.join("\n- ")}`);
    this.name = "VoiceSidecarWireContractError";
    this.issues = issues;
  }
}

export function voiceSidecarWireContractSha256(): string {
  return createHash("sha256").update(readFileSync(VOICE_SIDECAR_WIRE_CONTRACT_PATH)).digest("hex");
}

export function loadVoiceSidecarWireContract(): WireContractFixture {
  const value = JSON.parse(readFileSync(VOICE_SIDECAR_WIRE_CONTRACT_PATH, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error("voice-sidecar wire contract is not an object");
  if (value["schemaVersion"] !== VOICE_SIDECAR_WIRE_CONTRACT_VERSION) {
    throw new Error("invalid voice-sidecar wire contract schemaVersion");
  }
  if (value["id"] !== VOICE_SIDECAR_WIRE_CONTRACT_ID) {
    throw new Error("invalid voice-sidecar wire contract id");
  }
  const derivedFrom = record(value["derivedFrom"]);
  if (derivedFrom?.["eventsSha256"] !== VOICE_SIDECAR_SOURCE_EVENTS_SHA256) {
    throw new Error("voice-sidecar wire contract has the wrong source events SHA-256");
  }
  if (!isRecord(value["consumedProjection"])) {
    throw new Error("voice-sidecar wire contract has no consumed projection");
  }
  return value as unknown as WireContractFixture;
}

export function wireMessagesFromEvents(events: readonly EventRecord[]): WireMessageRecord[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .flatMap((event): WireMessageRecord[] => {
      if (event.type === "appserver.rpc.in") return [{ direction: "in", message: event.data }];
      if (event.type === "appserver.rpc.out") return [{ direction: "out", message: event.data }];
      return [];
    });
}

export function projectConsumedWireContract(
  records: readonly WireMessageRecord[],
): ConsumedWireContractProjection {
  const requestIds = new Map<string | number, string>();
  const requestCounts = new Map<string, number>();
  const responseCounts = new Map<string, number>();
  const clientNotificationCounts = new Map<string, number>();
  const serverNotificationCounts = new Map<string, number>();
  const realtimeStarts: Record<string, unknown>[] = [];
  const threadStarts: Record<string, unknown>[] = [];
  const handoffItems: Record<string, unknown>[] = [];
  const closeReasons: unknown[] = [];

  for (const record of records) {
    const { message } = record;
    const method = typeof message["method"] === "string" ? message["method"] : null;
    const id = requestId(message["id"]);
    if (record.direction === "out" && method) {
      if (id === null) {
        clientNotificationCounts.set(method, (clientNotificationCounts.get(method) ?? 0) + 1);
      } else {
        requestIds.set(id, method);
        requestCounts.set(method, (requestCounts.get(method) ?? 0) + 1);
      }
      const params = recordValue(message["params"]);
      if (method === "thread/start" && params) threadStarts.push(params);
      if (method === "thread/realtime/start" && params) realtimeStarts.push(params);
      continue;
    }
    if (record.direction !== "in") continue;
    if (method) {
      serverNotificationCounts.set(method, (serverNotificationCounts.get(method) ?? 0) + 1);
      const params = recordValue(message["params"]);
      if (method === "thread/realtime/itemAdded") {
        const item = recordValue(params?.["item"]);
        if (item) handoffItems.push(item);
      }
      if (method === "thread/realtime/closed") closeReasons.push(params?.["reason"]);
    } else if (id !== null) {
      const responseMethod = requestIds.get(id);
      if (responseMethod) {
        responseCounts.set(responseMethod, (responseCounts.get(responseMethod) ?? 0) + 1);
      }
    }
  }

  const threadStart = threadStarts[0] ?? {};
  const threadConfig = recordValue(threadStart["config"]);
  const realtimeStart = realtimeStarts[0] ?? {};
  const realtimeTransport = recordValue(realtimeStart["transport"]);
  const requiredFields = HANDOFF_REQUIRED_FIELDS.filter((field) =>
    handoffItems.every((item) => field in item),
  );
  const itemTypes = new Set(handoffItems.map((item) => item["type"]));
  const closeReasonSet = new Set(closeReasons);

  return {
    clientNotifications: [
      { method: "initialized", count: clientNotificationCounts.get("initialized") ?? 0 },
    ],
    requests: REQUEST_METHODS.map((method) => ({
      method,
      count: requestCounts.get(method) ?? 0,
      responseCount: responseCounts.get(method) ?? 0,
    })),
    serverNotifications: SERVER_NOTIFICATION_METHODS.map((method) => ({
      method,
      count: serverNotificationCounts.get(method) ?? 0,
    })),
    threadStart: {
      approvalPolicy: threadStart["approvalPolicy"] ?? null,
      sandbox: threadStart["sandbox"] ?? null,
      model: threadStart["model"] ?? null,
      ephemeral: threadStart["ephemeral"] ?? null,
      reasoningEffort: threadConfig?.["model_reasoning_effort"] ?? null,
    },
    realtimeStart: {
      version: realtimeStart["version"] ?? null,
      voice: realtimeStart["voice"] ?? null,
      outputModality: realtimeStart["outputModality"] ?? null,
      includeStartupContext: realtimeStart["includeStartupContext"] ?? null,
      clientManagedHandoffs: realtimeStart["clientManagedHandoffs"] ?? null,
      delegationAckFiller: realtimeStart["delegationAckFiller"] ?? null,
      modelOverride: "model" in realtimeStart ? "present" : "absent",
      transport: realtimeTransport?.["type"] ?? null,
    },
    handoffRequests: {
      count: handoffItems.length,
      type: itemTypes.size === 1 ? itemTypes.values().next().value : null,
      requiredFields: [...requiredFields],
    },
    requestedClose: {
      requestCount: requestCounts.get("thread/realtime/stop") ?? 0,
      notificationCount: closeReasons.length,
      reason: closeReasonSet.size === 1 ? closeReasonSet.values().next().value : null,
    },
  };
}

export function assertConsumedWireContract(records: readonly WireMessageRecord[]): void {
  const fixture = loadVoiceSidecarWireContract();
  const projection = projectConsumedWireContract(records);
  const issues = exactWireIssues(records);
  if (projection.realtimeStart.modelOverride !== "absent") {
    issues.push("thread/realtime/start must omit the model override");
  }
  if (JSON.stringify(projection) !== JSON.stringify(fixture.consumedProjection)) {
    issues.push("consumed legacy/native wire projection did not match agentvoice-codex-fx-v1");
  }
  if (issues.length > 0) throw new VoiceSidecarWireContractError(issues);
}

function exactWireIssues(records: readonly WireMessageRecord[]): string[] {
  const issues: string[] = [];
  const pendingRequests = new Map<string | number, string>();
  const completedRequestIds = new Set<string | number>();

  for (const [index, record] of records.entries()) {
    const label = `wire message ${index + 1}`;
    if (record.direction !== "in" && record.direction !== "out") {
      issues.push(`${label} has invalid direction ${String(record.direction)}`);
      continue;
    }
    const message = recordValue(record.message);
    if (!message) {
      issues.push(`${label} message is not an object`);
      continue;
    }

    const hasMethod = hasOwn(message, "method");
    const rawMethod = message["method"];
    if (hasMethod && (typeof rawMethod !== "string" || rawMethod.length === 0)) {
      issues.push(`${label} has a malformed method`);
      continue;
    }
    const method = hasMethod ? (rawMethod as string) : null;
    const hasId = hasOwn(message, "id");
    const id = hasId ? requestId(message["id"]) : null;
    if (hasId && id === null) {
      if (record.direction === "in" && method) {
        issues.push(`${label} is an inbound server request with id:null + method ${method}`);
      } else {
        issues.push(`${label} has malformed id ${formatId(message["id"])}`);
      }
      continue;
    }

    if (record.direction === "out") {
      validateOutboundMessage(
        label,
        method,
        hasId,
        id,
        pendingRequests,
        completedRequestIds,
        issues,
      );
    } else {
      validateInboundMessage(
        label,
        message,
        method,
        hasId,
        id,
        pendingRequests,
        completedRequestIds,
        issues,
      );
    }
  }

  for (const [id, method] of pendingRequests) {
    issues.push(
      `wire contract ended with unanswered outbound request id ${formatId(id)} method ${method}`,
    );
  }

  return issues;
}

function validateOutboundMessage(
  label: string,
  method: string | null,
  hasId: boolean,
  id: string | number | null,
  pendingRequests: Map<string | number, string>,
  completedRequestIds: Set<string | number>,
  issues: string[],
): void {
  if (method) {
    if (hasId) {
      if (!REQUEST_METHOD_SET.has(method)) {
        issues.push(`${label} has unexpected outbound request method ${method}`);
      }
      if (id !== null) {
        if (pendingRequests.has(id) || completedRequestIds.has(id)) {
          issues.push(`${label} reuses outbound request id ${formatId(id)}`);
        } else {
          pendingRequests.set(id, method);
        }
      }
    } else if (method !== "initialized") {
      issues.push(`${label} has unexpected outbound notification method ${method}`);
    }
    return;
  }

  if (hasId) {
    issues.push(`${label} is an unexpected outbound response with id ${formatId(id)}`);
  } else {
    issues.push(`${label} has neither method nor id`);
  }
}

function validateInboundMessage(
  label: string,
  message: Record<string, unknown>,
  method: string | null,
  hasId: boolean,
  id: string | number | null,
  pendingRequests: Map<string | number, string>,
  completedRequestIds: Set<string | number>,
  issues: string[],
): void {
  if (method) {
    if (hasId) {
      issues.push(`${label} is an inbound server request with method ${method}`);
    } else if (!SERVER_NOTIFICATION_METHOD_SET.has(method)) {
      issues.push(`${label} has unexpected inbound notification method ${method}`);
    }
    return;
  }

  if (!hasId) {
    issues.push(`${label} has neither method nor id`);
    return;
  }
  if (id === null || !pendingRequests.has(id)) {
    issues.push(`${label} has unknown inbound response id ${formatId(id)}`);
    return;
  }
  if (hasOwn(message, "result") === hasOwn(message, "error")) {
    issues.push(
      `${label} response for id ${formatId(id)} must contain exactly one of result or error`,
    );
    return;
  }
  if (hasOwn(message, "error")) {
    issues.push(`${label} response for id ${formatId(id)} unexpectedly returned an error`);
  }
  pendingRequests.delete(id);
  completedRequestIds.add(id);
}

function requestId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function formatId(id: unknown): string {
  return id === null ? "null" : JSON.stringify(id);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
