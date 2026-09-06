import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { confirmFullAccess, validateFullAccessParams } from "./full-access.ts";

export type Json = Record<string, unknown>;
export type AttachmentIdentity = { threadId: string; workspace: string };
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Json;
}
function keys(params: Json, allowed: string[]): void {
  // Remove unused serde placeholders so unknown double-option fields cannot become overrides.
  for (const [key, value] of Object.entries(params))
    if (value === null && !allowed.includes(key)) delete params[key];
  const unknown = Object.entries(params)
    .filter(([key, value]) => value !== null && !allowed.includes(key))
    .map(([key]) => key);
  if (unknown.length) throw new Error(`Attachment does not support ${unknown.join(", ")}`);
}
function cwd(value: unknown, workspace: string): void {
  if (value == null) return;
  if (typeof value !== "string" || !isAbsolute(value) || realpathSync(value) !== workspace)
    throw new Error("Attachment cannot change workspace");
}
const SETTINGS = [
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "permissions",
  "model",
  "effort",
  "summary",
  "serviceTier",
  "personality",
  "collaborationMode",
];
function settings(params: Json, identity: AttachmentIdentity): void {
  cwd(params["cwd"], identity.workspace);
  validateFullAccessParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value != null)),
  );
  if (params["sandboxPolicy"] != null) {
    const sandbox = object(params["sandboxPolicy"]);
    if (sandbox["type"] !== "dangerFullAccess" || Object.keys(sandbox).length !== 1)
      throw new Error("Attachment requires dangerFullAccess / never");
  }
  if (params["runtimeWorkspaceRoots"] != null) {
    if (!Array.isArray(params["runtimeWorkspaceRoots"])) throw new Error("Invalid workspace roots");
    for (const root of params["runtimeWorkspaceRoots"]) cwd(root, identity.workspace);
  }
}

/** Reject before native dispatch. Unknown mutations never acquire an implementation by forwarding. */
export function validateAttachmentRequest(
  method: string,
  params: Json,
  identity: AttachmentIdentity,
): void {
  if (
    (method.startsWith("thread/") && !["thread/list", "thread/loaded/list"].includes(method)) ||
    method.startsWith("turn/")
  ) {
    if (params["threadId"] !== identity.threadId)
      throw new Error("Attachment is bound to one thread");
  }
  switch (method) {
    case "initialize":
      keys(params, ["clientInfo", "capabilities"]);
      break;
    case "thread/resume":
      keys(params, [
        "threadId",
        "cwd",
        "approvalPolicy",
        "sandbox",
        "permissions",
        "excludeTurns",
        "initialTurnsPage",
        "runtimeWorkspaceRoots",
        "approvalsReviewer",
        "model",
        "serviceTier",
        "config",
      ]);
      settings(params, identity);
      if (params["config"] != null) {
        const config = object(params["config"]);
        keys(config, [
          "default_permissions",
          "model_reasoning_effort",
          "model_reasoning_summary",
          "model_verbosity",
          "personality",
          "web_search",
          "features",
        ]);
        if (config["features"] != null) {
          const features = object(config["features"]);
          keys(features, ["realtime_conversation"]);
          if (features["realtime_conversation"] !== true)
            throw new Error("Attachment cannot disable realtime");
        }
      }
      break;
    case "thread/read":
      keys(params, ["threadId", "includeTurns"]);
      break;
    case "thread/turns/list":
      keys(params, ["threadId", "cursor", "limit", "itemsView", "sortDirection"]);
      break;
    case "thread/items/list":
      keys(params, ["threadId", "turnId", "cursor", "limit", "sortDirection"]);
      break;
    case "thread/unsubscribe":
    case "thread/goal/get":
      keys(params, ["threadId"]);
      break;
    case "thread/settings/update":
      keys(params, ["threadId", ...SETTINGS]);
      settings(params, identity);
      break;
    case "turn/start":
      keys(params, [
        "threadId",
        "clientUserMessageId",
        "input",
        "runtimeWorkspaceRoots",
        "outputSchema",
        ...SETTINGS,
      ]);
      settings(params, identity);
      if (!Array.isArray(params["input"]) || params["input"].length === 0)
        throw new Error("Input is required");
      break;
    case "turn/steer":
      keys(params, ["threadId", "expectedTurnId", "clientUserMessageId", "input"]);
      break;
    case "turn/interrupt":
      keys(params, ["threadId", "turnId"]);
      break;
    case "model/list":
      keys(params, ["cursor", "limit", "includeHidden"]);
      break;
    case "config/read":
      keys(params, ["cwd", "includeLayers"]);
      cwd(params["cwd"], identity.workspace);
      break;
    case "configRequirements/read":
    case "account/rateLimits/read":
      keys(params, []);
      break;
    case "account/read":
      keys(params, ["refreshToken"]);
      if (params["refreshToken"] === true)
        throw new Error("Attachment cannot refresh authentication");
      break;
    case "hooks/list":
    case "skills/list":
      keys(params, ["cwds", "forceReload"]);
      if (!Array.isArray(params["cwds"]) || params["cwds"].length !== 1)
        throw new Error("Skills require the selected workspace");
      cwd(params["cwds"][0], identity.workspace);
      break;
    case "mcpServerStatus/list":
      keys(params, ["cursor", "limit", "threadId"]);
      if (params["threadId"] != null && params["threadId"] !== identity.threadId)
        throw new Error("Attachment is bound to one thread");
      break;
    case "thread/list":
      keys(params, [
        "cursor",
        "limit",
        "cwd",
        "sortKey",
        "modelProviders",
        "sourceKinds",
        "archived",
        "searchTerm",
      ]);
      cwd(params["cwd"], identity.workspace);
      break;
    case "thread/loaded/list":
      keys(params, []);
      break;
    default:
      throw new Error(`Attachment does not support ${method}`);
  }
}

export function attachmentResult(
  method: string,
  result: unknown,
  identity: AttachmentIdentity,
): unknown {
  const data = object(result);
  if (method === "thread/resume") {
    confirmFullAccess(data);
    const thread = object(data["thread"]);
    if (thread["id"] !== identity.threadId || thread["cwd"] !== identity.workspace)
      throw new Error("Native attachment identity mismatch");
  }
  if (method === "thread/read") {
    const thread = object(data["thread"]);
    if (thread["id"] !== identity.threadId || thread["cwd"] !== identity.workspace)
      throw new Error("Native attachment identity mismatch");
  }
  if (method === "thread/list" || method === "thread/loaded/list") {
    return {
      ...data,
      nextCursor: null,
      data: (data["data"] as unknown[]).filter((row) =>
        method === "thread/loaded/list"
          ? row === identity.threadId
          : object(row)["id"] === identity.threadId,
      ),
    };
  }
  return result;
}

export function attachmentNotification(
  method: string,
  params: Json,
  identity: AttachmentIdentity,
): boolean {
  if (method.startsWith("thread/realtime/") || method.startsWith("rawResponse")) return false;
  if (params["threadId"] !== undefined) return params["threadId"] === identity.threadId;
  if (method === "thread/started") return object(params["thread"])["id"] === identity.threadId;
  return [
    "account/rateLimits/updated",
    "account/updated",
    "model/rerouted",
    "warning",
    "deprecationNotice",
    "serverRequest/resolved",
  ].includes(method);
}
