import type { Message, RoutingBalance, RoutingContextPresentation } from "../../types/message.ts";

type Row = Record<string, unknown>;

const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

const text = (value: unknown, maximum = 128) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
};

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function decodedOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    const part = row(value[0]);
    if (part?.["type"] !== "input_text") return undefined;
    value = part["text"];
  }
  for (let layer = 0; layer < 2 && typeof value === "string"; layer++) {
    if (value.length > 262_144 || !/^\s*[{[]/.test(value)) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function percent(value: unknown) {
  const number = finite(value);
  return number !== undefined && number >= 0 && number <= 100 ? number : undefined;
}

function balance(
  provider: RoutingBalance["provider"],
  account: string,
  lane: unknown,
  value: unknown,
  resetsAt: unknown,
  eligible?: boolean,
): RoutingBalance | undefined {
  const remainingPercent = percent(value);
  if (remainingPercent === undefined) return undefined;
  return {
    provider,
    account,
    lane: text(lane, 64) ?? (provider === "Codex" ? "quota" : "included"),
    usedPercent: 100 - remainingPercent,
    ...(text(resetsAt, 64) ? { resetsAt: text(resetsAt, 64) } : {}),
    ...(eligible === undefined ? {} : { eligible }),
  };
}

/**
 * Project the public routing delivery into the only fields the transcript card may render.
 * Account keys, source prose, digests, host identity and raw native output never cross this boundary.
 */
export function routingContextPresentation(value: unknown): RoutingContextPresentation | null {
  const output = row(decodedOutput(value));
  if (output?.["schema_version"] !== 1 || output["type"] !== "routing.context") return null;
  const delivery = row(output["context"]);
  const mode = delivery?.["mode"];
  const revision = finite(delivery?.["context_revision"]);
  const generation = finite(delivery?.["producer_generation"]);
  if (
    (mode !== "full" && mode !== "delta") ||
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    generation === undefined ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return null;

  const payload = row(delivery?.["payload"]);
  if (!payload) return null;
  const current = row(payload["current"]);
  const quota = row(payload["quota"]);
  const balances: RoutingBalance[] = [];
  if (quota && Array.isArray(quota["accounts"])) {
    for (const [accountIndex, candidate] of quota["accounts"].slice(0, 16).entries()) {
      if (balances.length >= 16) break;
      const account = row(candidate);
      const lane = row(account?.["lane"]);
      if (!Array.isArray(lane?.["windows"])) continue;
      for (const candidateWindow of lane.windows.slice(0, 16)) {
        if (balances.length >= 16) break;
        const window = row(candidateWindow);
        const projected = balance(
          "Codex",
          `codex-${accountIndex + 1}`,
          window?.["role"],
          window?.["remaining_percent"],
          window?.["resets_at"],
          typeof account?.["eligible"] === "boolean" ? account["eligible"] : undefined,
        );
        if (projected) balances.push(projected);
      }
    }
  }
  if (quota && Array.isArray(quota["grok"])) {
    for (const [accountIndex, candidate] of quota["grok"].slice(0, 16).entries()) {
      if (balances.length >= 16) break;
      const account = row(candidate);
      const included = row(account?.["included"]);
      const projected = balance(
        "Grok",
        `grok-${accountIndex + 1}`,
        "included",
        included?.["remainingPercent"],
        included?.["resetsAt"],
        typeof account?.["enabled"] === "boolean" && typeof account?.["stale"] === "boolean"
          ? account["enabled"] && !account["stale"]
          : undefined,
      );
      if (projected) balances.push(projected);
    }
  }

  const currentProjection = current
    ? {
        ...(text(current["provider"]) ? { provider: text(current["provider"]) } : {}),
        ...(text(current["model"]) ? { model: text(current["model"]) } : {}),
        ...(text(current["effort"]) ? { effort: text(current["effort"]) } : {}),
        ...(text(current["service_tier"]) ? { serviceTier: text(current["service_tier"]) } : {}),
      }
    : undefined;
  const observedAt = text(payload["observed_at"], 64);
  const expiresAt = text(payload["expires_at"], 64);
  const delegationAvailable =
    quota && typeof quota["delegation_available"] === "boolean"
      ? quota["delegation_available"]
      : undefined;
  if (
    (!currentProjection || Object.keys(currentProjection).length === 0) &&
    balances.length === 0 &&
    delegationAvailable === undefined
  )
    return null;

  return {
    revision,
    generation,
    mode,
    ...(currentProjection && Object.keys(currentProjection).length
      ? { current: currentProjection }
      : {}),
    ...(delegationAvailable === undefined ? {} : { delegationAvailable }),
    ...(quota ? { balances } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function routingContextMessage(
  namespace: unknown,
  name: unknown,
  output: unknown,
): Omit<Message, "id"> | null | undefined {
  if (namespace !== "agentusage" || name !== "routing_context") return undefined;
  const routingContext = routingContextPresentation(output);
  if (!routingContext) return null;
  return {
    role: "system",
    status: "complete",
    content: "Routing context updated.",
    nativeItemType: "agentusage.routing_context",
    routingContext,
  };
}
