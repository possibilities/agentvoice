import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ownedDirectory, ownedFile } from "../private-files.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean => value === true;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const valueRow = value as Row;
  return `{${Object.keys(valueRow)
    .filter((key) => valueRow[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(valueRow[key])}`)
    .join(",")}}`;
}

export function routingDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export type RoutingUsageReading = { key: string; displayedPercent: number };

export type RoutingContextView = {
  current: {
    provider: string | null;
    model: string | null;
    effort: string | null;
    serviceTier: string | null;
  };
  guidance: {
    taskFit: string[];
    routingEnabled: boolean;
    codexCostOrder: string[];
  };
  nativeCatalog: {
    capabilityDigest: string | null;
    drift: string[];
    models: Array<{
      model: string | null;
      efforts: string[];
      serviceTiers: string[];
      hidden: boolean;
    }>;
  };
  quota: {
    sourceRevision: string | number | null;
    eligibleAccountKeys: string[];
    delegationAvailable: boolean;
    accounts: Array<{
      accountKey: string | null;
      accountGeneration: number | null;
      providerGeneration: number | null;
      authStatus: string | null;
      decisionGrade: boolean;
      eligible: boolean;
      exclusions: string[];
      windows: Array<{
        role: string | null;
        windowSeconds: number | null;
        usedPercent: number | null;
        remainingPercent: number | null;
        resetsAt: string | null;
      }>;
    }>;
    grok: Array<{
      accountKey: string | null;
      enabled: boolean;
      authStatus: string | null;
      billingStatus: string | null;
      stale: boolean;
      usedPercent: number | null;
      remainingPercent: number | null;
      resetsAt: string | null;
      errorCode: string | null;
    }>;
  };
  grokCatalog: {
    status: string | null;
    expiresAt: string | null;
    drift: Array<{ code: string | null; subject: string | null; accountKey: string | null }>;
    routable: { defaultModel: string | null; models: string[] };
    accounts: Array<{
      accountKey: string | null;
      fresh: boolean;
      credentialCurrent: boolean;
      errorCode: string | null;
    }>;
  };
};

const routingWindowViewSchema = z
  .object({
    role: z.string().nullable(),
    windowSeconds: z.number().nullable(),
    usedPercent: z.number().nullable(),
    remainingPercent: z.number().nullable(),
    resetsAt: z.string().nullable(),
  })
  .strict();
const routingAccountViewSchema = z
  .object({
    accountKey: z.string().nullable(),
    accountGeneration: z.number().nullable(),
    providerGeneration: z.number().nullable(),
    authStatus: z.string().nullable(),
    decisionGrade: z.boolean(),
    eligible: z.boolean(),
    exclusions: z.array(z.string()).max(64),
    windows: z.array(routingWindowViewSchema).max(32),
  })
  .strict();
const routingGrokViewSchema = z
  .object({
    accountKey: z.string().nullable(),
    enabled: z.boolean(),
    authStatus: z.string().nullable(),
    billingStatus: z.string().nullable(),
    stale: z.boolean(),
    usedPercent: z.number().nullable(),
    remainingPercent: z.number().nullable(),
    resetsAt: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();

export const routingContextViewSchema: z.ZodType<RoutingContextView> = z
  .object({
    current: z
      .object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
        effort: z.string().nullable(),
        serviceTier: z.string().nullable(),
      })
      .strict(),
    guidance: z
      .object({
        taskFit: z.array(z.string()).max(64),
        routingEnabled: z.boolean(),
        codexCostOrder: z.array(z.string()).max(64),
      })
      .strict(),
    nativeCatalog: z
      .object({
        capabilityDigest: z.string().nullable(),
        drift: z.array(z.string()).max(256),
        models: z
          .array(
            z
              .object({
                model: z.string().nullable(),
                efforts: z.array(z.string()).max(16),
                serviceTiers: z.array(z.string()).max(16),
                hidden: z.boolean(),
              })
              .strict(),
          )
          .max(256),
      })
      .strict(),
    quota: z
      .object({
        sourceRevision: z.union([z.string(), z.number()]).nullable(),
        eligibleAccountKeys: z.array(z.string()).max(512),
        delegationAvailable: z.boolean(),
        accounts: z.array(routingAccountViewSchema).max(512),
        grok: z.array(routingGrokViewSchema).max(512),
      })
      .strict(),
    grokCatalog: z
      .object({
        status: z.string().nullable(),
        expiresAt: z.string().nullable(),
        drift: z
          .array(
            z
              .object({
                code: z.string().nullable(),
                subject: z.string().nullable(),
                accountKey: z.string().nullable(),
              })
              .strict(),
          )
          .max(512),
        routable: z
          .object({ defaultModel: z.string().nullable(), models: z.array(z.string()).max(512) })
          .strict(),
        accounts: z
          .array(
            z
              .object({
                accountKey: z.string().nullable(),
                fresh: z.boolean(),
                credentialCurrent: z.boolean(),
                errorCode: z.string().nullable(),
              })
              .strict(),
          )
          .max(512),
      })
      .strict(),
  })
  .strict();

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

/** Project the strict public composer/catalog output; source prose and private identity never pass this allowlist. */
export function routingContextView(
  contextValue: unknown,
  grokCatalogValue: unknown,
): RoutingContextView {
  const context = row(contextValue);
  const current = row(context["current"]);
  const guidance = row(context["guidance"]);
  const policy = row(guidance["routing_policy"]);
  const nativeCatalog = row(context["native_catalog"]);
  const quota = row(context["quota"]);
  const grokCatalog = row(grokCatalogValue);
  const visibility = row(grokCatalog["visibility"]);
  const routable = row(grokCatalog["routable"]);
  return {
    current: {
      provider: string(current["provider"]),
      model: string(current["model"]),
      effort: string(current["effort"]),
      serviceTier: string(current["service_tier"]),
    },
    guidance: {
      taskFit: strings(guidance["task_fit"]),
      routingEnabled: bool(policy["enabled"]),
      codexCostOrder: strings(policy["codex_cost_order"]),
    },
    nativeCatalog: {
      capabilityDigest: string(nativeCatalog["capability_digest"]),
      drift: strings(nativeCatalog["drift"]),
      models: array(nativeCatalog["models"]).map((value) => {
        const model = row(value);
        return {
          model: string(model["model"]),
          efforts: strings(model["efforts"]),
          serviceTiers: strings(model["service_tiers"]),
          hidden: bool(model["hidden"]),
        };
      }),
    },
    quota: {
      sourceRevision:
        typeof quota["source_revision"] === "string" || typeof quota["source_revision"] === "number"
          ? quota["source_revision"]
          : null,
      eligibleAccountKeys: strings(quota["eligible_account_keys"]),
      delegationAvailable: bool(quota["delegation_available"]),
      accounts: array(quota["accounts"]).map((value) => {
        const account = row(value);
        const lane = row(account["lane"]);
        return {
          accountKey: string(account["account_key"]),
          accountGeneration: number(account["account_generation"]),
          providerGeneration: number(account["provider_generation"]),
          authStatus: string(account["auth_status"]),
          decisionGrade: bool(account["decision_grade"]),
          eligible: bool(account["eligible"]),
          exclusions: strings(account["exclusions"]),
          windows: array(lane["windows"]).map((value) => {
            const window = row(value);
            return {
              role: string(window["role"]),
              windowSeconds: number(window["window_seconds"]),
              usedPercent: number(window["used_percent"]),
              remainingPercent: number(window["remaining_percent"]),
              resetsAt: string(window["resets_at"]),
            };
          }),
        };
      }),
      grok: array(quota["grok"]).map((value) => {
        const account = row(value);
        const included = row(account["included"]);
        const error = row(account["error"]);
        return {
          accountKey: string(account["accountKey"]),
          enabled: bool(account["enabled"]),
          authStatus: string(account["authStatus"]),
          billingStatus: string(account["billingStatus"]),
          stale: bool(account["stale"]),
          usedPercent: number(included["usedPercent"]),
          remainingPercent: number(included["remainingPercent"]),
          resetsAt: string(included["resetsAt"]),
          errorCode: string(error["code"]),
        };
      }),
    },
    grokCatalog: {
      status: string(grokCatalog["status"]),
      expiresAt: string(grokCatalog["expires_at"]),
      drift: array(grokCatalog["drift"]).map((value) => {
        const drift = row(value);
        return {
          code: string(drift["code"]),
          subject: string(drift["subject"]),
          accountKey: string(drift["account_key"]),
        };
      }),
      routable: {
        defaultModel: string(routable["default_model"]),
        models: array(routable["models"])
          .map((value) => string(row(value)["model"]))
          .filter((value): value is string => value !== null),
      },
      accounts: array(visibility["accounts"]).map((value) => {
        const account = row(value);
        return {
          accountKey: string(account["account_key"]),
          fresh: bool(account["fresh"]),
          credentialCurrent: bool(account["credential_current"]),
          errorCode: string(account["error_code"]),
        };
      }),
    },
  };
}

function decisionProjection(view: RoutingContextView): unknown {
  const { expiresAt: _catalogExpiry, ...grokCatalog } = view.grokCatalog;
  return {
    current: view.current,
    guidance: view.guidance,
    nativeCatalog: view.nativeCatalog,
    quota: {
      eligibleAccountKeys: view.quota.eligibleAccountKeys,
      delegationAvailable: view.quota.delegationAvailable,
      accounts: view.quota.accounts.map((account) => ({
        ...account,
        windows: account.windows.map(
          ({ usedPercent: _used, remainingPercent: _remaining, ...window }) => window,
        ),
      })),
      grok: view.quota.grok.map(
        ({ usedPercent: _used, remainingPercent: _remaining, ...account }) => account,
      ),
    },
    grokCatalog,
  };
}

export function routingUsage(view: RoutingContextView): RoutingUsageReading[] {
  const readings: RoutingUsageReading[] = [];
  for (const account of view.quota.accounts)
    for (const window of account.windows)
      if (account.accountKey && window.role && window.remainingPercent !== null)
        readings.push({
          key: `codex:${account.accountKey}:${window.role}`,
          displayedPercent: Math.round(window.remainingPercent * 10) / 10,
        });
  for (const account of view.quota.grok)
    if (account.accountKey && account.remainingPercent !== null)
      readings.push({
        key: `grok:${account.accountKey}:included`,
        displayedPercent: Math.round(account.remainingPercent * 10) / 10,
      });
  return readings.sort((left, right) => left.key.localeCompare(right.key));
}

export type RoutingCandidate = {
  view: RoutingContextView;
  signalDigest: string;
  candidateDigest: string;
  usage: RoutingUsageReading[];
};

export function routingCandidate(context: unknown, grokCatalog: unknown): RoutingCandidate {
  const view = routingContextView(context, grokCatalog);
  const signalDigest = routingDigest(decisionProjection(view));
  const usage = routingUsage(view);
  return { view, signalDigest, candidateDigest: routingDigest(usage), usage };
}

export type DeliveredRoutingBaseline = RoutingCandidate & {
  schemaVersion: 2;
  streamId: string;
  deliveredAt: string;
  turnId: string;
  producerGeneration: number;
  contextRevision: number;
  contextDigest: string;
  deliveryMode: "full" | "delta";
  observedAt: string;
  expiresAt: string;
  controllerId: string;
  controllerGeneration: number;
  threadId: string;
  runtimeBuildId: string;
};

export type RoutingDeliveryDecision =
  | { deliver: true; reason: "initial" | "usage_change" }
  | { deliver: false; reason: "unchanged" | "cooldown" | "already_attempted" };

export type RoutingTurnAttempt = {
  schemaVersion: 1 | 2;
  streamId: string;
  attemptedAt: string;
  candidateDigest: string;
  producerGeneration: number;
  contextRevision: number;
  contextDigest: string;
};

export function planRoutingTurn(
  baseline: Pick<DeliveredRoutingBaseline, "usage" | "deliveredAt"> | null,
  candidate: RoutingCandidate,
  nowMs: number,
  cooldownMs = 5 * 60_000,
): RoutingDeliveryDecision {
  if (!baseline) return { deliver: true, reason: "initial" };
  const previous = new Map(
    baseline.usage.map((reading) => [reading.key, reading.displayedPercent]),
  );
  const changed =
    previous.size !== candidate.usage.length ||
    candidate.usage.some((reading) => previous.get(reading.key) !== reading.displayedPercent);
  if (!changed) return { deliver: false, reason: "unchanged" };
  const deliveredAt = Date.parse(baseline.deliveredAt);
  if (!Number.isFinite(deliveredAt) || nowMs - deliveredAt < cooldownMs)
    return { deliver: false, reason: "cooldown" };
  return { deliver: true, reason: "usage_change" };
}

export interface RoutingDeliveryStore {
  read(streamId: string): DeliveredRoutingBaseline | null;
  write(baseline: DeliveredRoutingBaseline): void;
  readAttempt(streamId: string): RoutingTurnAttempt | null;
  writeAttempt(attempt: RoutingTurnAttempt): void;
}

export class MemoryRoutingDeliveryStore implements RoutingDeliveryStore {
  private readonly values = new Map<string, DeliveredRoutingBaseline>();
  private readonly attempts = new Map<string, RoutingTurnAttempt>();
  read(streamId: string) {
    return structuredClone(this.values.get(streamId) ?? null);
  }
  write(baseline: DeliveredRoutingBaseline) {
    this.values.set(baseline.streamId, structuredClone(baseline));
  }
  readAttempt(streamId: string) {
    return structuredClone(this.attempts.get(streamId) ?? null);
  }
  writeAttempt(attempt: RoutingTurnAttempt) {
    this.attempts.set(attempt.streamId, structuredClone(attempt));
  }
}

const MAX_STATE_BYTES = 512 * 1024;
const HEX = /^[a-f0-9]{64}$/u;

function validBaseline(value: unknown, streamId: string): value is DeliveredRoutingBaseline {
  const state = row(value);
  const exact = [
    "schemaVersion",
    "streamId",
    "deliveredAt",
    "turnId",
    "producerGeneration",
    "contextRevision",
    "contextDigest",
    "deliveryMode",
    "observedAt",
    "expiresAt",
    "controllerId",
    "controllerGeneration",
    "threadId",
    "runtimeBuildId",
    "view",
    "signalDigest",
    "candidateDigest",
    "usage",
  ];
  return (
    Object.keys(state).length === exact.length &&
    exact.every((key) => Object.hasOwn(state, key)) &&
    state["schemaVersion"] === 2 &&
    state["streamId"] === streamId &&
    typeof state["deliveredAt"] === "string" &&
    Number.isFinite(Date.parse(state["deliveredAt"])) &&
    typeof state["observedAt"] === "string" &&
    Number.isFinite(Date.parse(state["observedAt"])) &&
    typeof state["expiresAt"] === "string" &&
    Number.isFinite(Date.parse(state["expiresAt"])) &&
    typeof state["turnId"] === "string" &&
    state["turnId"].length > 0 &&
    state["turnId"].length <= 128 &&
    Number.isSafeInteger(state["producerGeneration"]) &&
    Number(state["producerGeneration"]) > 0 &&
    Number.isSafeInteger(state["contextRevision"]) &&
    Number(state["contextRevision"]) > 0 &&
    typeof state["contextDigest"] === "string" &&
    HEX.test(state["contextDigest"]) &&
    (state["deliveryMode"] === "full" || state["deliveryMode"] === "delta") &&
    typeof state["controllerId"] === "string" &&
    state["controllerId"].length > 0 &&
    Number.isSafeInteger(state["controllerGeneration"]) &&
    Number(state["controllerGeneration"]) > 0 &&
    typeof state["threadId"] === "string" &&
    state["threadId"].length > 0 &&
    typeof state["runtimeBuildId"] === "string" &&
    state["runtimeBuildId"].length > 0 &&
    typeof state["signalDigest"] === "string" &&
    HEX.test(state["signalDigest"]) &&
    typeof state["candidateDigest"] === "string" &&
    HEX.test(state["candidateDigest"]) &&
    Array.isArray(state["usage"]) &&
    state["usage"].every((item) => {
      const reading = row(item);
      return (
        Object.keys(reading).length === 2 &&
        typeof reading["key"] === "string" &&
        typeof reading["displayedPercent"] === "number" &&
        Number.isFinite(reading["displayedPercent"])
      );
    }) &&
    routingContextViewSchema.safeParse(state["view"]).success
  );
}

function legacyBaseline(value: unknown, streamId: string): DeliveredRoutingBaseline | null {
  const state = row(value);
  if (state["schemaVersion"] !== 1 || state["streamId"] !== streamId) return null;
  const usage = array(state["usage"]);
  if (
    !usage.every((item) => {
      const reading = row(item);
      return (
        Object.keys(reading).length === 2 &&
        typeof reading["key"] === "string" &&
        typeof reading["usedPercent"] === "number" &&
        Number.isFinite(reading["usedPercent"])
      );
    })
  )
    return null;
  const migrated: Row = {
    ...state,
    schemaVersion: 2,
    usage: usage.map((item) => {
      const reading = row(item);
      return {
        key: reading["key"],
        displayedPercent: Math.round((100 - Number(reading["usedPercent"])) * 10) / 10,
      };
    }),
  };
  migrated["candidateDigest"] = routingDigest(migrated["usage"]);
  return validBaseline(migrated, streamId) ? migrated : null;
}

export class FileRoutingDeliveryStore implements RoutingDeliveryStore {
  private readonly directory: string;
  constructor(stateDir: string) {
    this.directory = join(stateDir, "routing-delivery");
  }
  private path(streamId: string) {
    return join(this.directory, `${routingDigest(streamId)}.json`);
  }
  private attemptPath(streamId: string) {
    return join(this.directory, `${routingDigest(streamId)}.attempt.json`);
  }
  read(streamId: string): DeliveredRoutingBaseline | null {
    const path = this.path(streamId);
    if (!lstatSync(path, { throwIfNoEntry: false })) return null;
    if (!ownedFile(path)) throw new Error("Routing delivery state is not a private owned file");
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > MAX_STATE_BYTES)
      throw new Error("Routing delivery state is oversized");
    const value = JSON.parse(text);
    if (validBaseline(value, streamId)) return value;
    const migrated = legacyBaseline(value, streamId);
    if (!migrated) throw new Error("Routing delivery state is malformed");
    return migrated;
  }
  write(baseline: DeliveredRoutingBaseline): void {
    this.writePrivate(this.path(baseline.streamId), baseline);
  }
  readAttempt(streamId: string): RoutingTurnAttempt | null {
    const path = this.attemptPath(streamId);
    if (!lstatSync(path, { throwIfNoEntry: false })) return null;
    if (!ownedFile(path)) throw new Error("Routing attempt state is not a private owned file");
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > MAX_STATE_BYTES)
      throw new Error("Routing attempt state is oversized");
    const value = row(JSON.parse(text));
    const keys = [
      "schemaVersion",
      "streamId",
      "attemptedAt",
      "candidateDigest",
      "producerGeneration",
      "contextRevision",
      "contextDigest",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      (value["schemaVersion"] !== 1 && value["schemaVersion"] !== 2) ||
      value["streamId"] !== streamId ||
      typeof value["attemptedAt"] !== "string" ||
      !Number.isFinite(Date.parse(value["attemptedAt"])) ||
      typeof value["candidateDigest"] !== "string" ||
      !HEX.test(value["candidateDigest"]) ||
      !Number.isSafeInteger(value["producerGeneration"]) ||
      Number(value["producerGeneration"]) < 1 ||
      !Number.isSafeInteger(value["contextRevision"]) ||
      Number(value["contextRevision"]) < 1 ||
      typeof value["contextDigest"] !== "string" ||
      !HEX.test(value["contextDigest"])
    )
      throw new Error("Routing attempt state is malformed");
    return value as RoutingTurnAttempt;
  }
  writeAttempt(attempt: RoutingTurnAttempt): void {
    this.writePrivate(this.attemptPath(attempt.streamId), attempt);
  }
  private writePrivate(path: string, value: unknown): void {
    ownedDirectory(this.directory);
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > MAX_STATE_BYTES)
      throw new Error("Routing delivery state is oversized");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, text);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // The successful rename removes the temporary path.
      }
    }
  }
}
