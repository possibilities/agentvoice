import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeliveredRoutingBaseline,
  FileRoutingDeliveryStore,
  planRoutingTurn,
  routingCandidate,
} from "../src/core/routing-delivery.ts";

function context(usedPercent = 20, eligible = true) {
  return {
    current: {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      service_tier: "priority",
    },
    guidance: {
      task_fit: ["implementation"],
      routing_policy: { enabled: true, codex_cost_order: ["gpt-5.6-terra", "gpt-5.6-sol"] },
    },
    native_catalog: {
      capability_digest: "a".repeat(64),
      drift: [],
      models: [
        { model: "gpt-5.6-sol", efforts: ["medium"], service_tiers: ["priority"], hidden: false },
      ],
    },
    quota: {
      source_revision: "42",
      eligible_account_keys: eligible ? ["codex-1"] : [],
      delegation_available: eligible,
      accounts: [
        {
          account_key: "codex-1",
          account_generation: 1,
          provider_generation: 1,
          auth_status: "ok",
          decision_grade: true,
          eligible,
          exclusions: eligible ? [] : ["quota_exhausted"],
          lane: {
            windows: [
              {
                role: "primary",
                window_seconds: 18_000,
                used_percent: usedPercent,
                remaining_percent: 100 - usedPercent,
                resets_at: "2026-09-18T00:00:00.000Z",
              },
            ],
          },
        },
      ],
      grok: [],
    },
  };
}

const grok = {
  status: "ok",
  expires_at: "2026-09-18T00:00:00.000Z",
  drift: [],
  visibility: { accounts: [] },
  routable: { default_model: null, models: [] },
};

function baseline(usedPercent = 20): DeliveredRoutingBaseline {
  return {
    schemaVersion: 1,
    streamId: "stream",
    deliveredAt: "2026-09-17T12:00:00.000Z",
    turnId: "turn-1",
    producerGeneration: 1,
    contextRevision: 1,
    contextDigest: "b".repeat(64),
    deliveryMode: "full",
    observedAt: "2026-09-17T11:59:00.000Z",
    expiresAt: "2026-09-17T12:04:00.000Z",
    controllerId: "controller",
    controllerGeneration: 1,
    threadId: "thread",
    runtimeBuildId: "build",
    ...routingCandidate(context(usedPercent), grok),
  };
}

test("repeated identical routing snapshots never create a turn, even after cooldown", () => {
  const previous = baseline();
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(), grok),
      Date.parse("2026-09-17T13:00:00Z"),
    ),
  ).toEqual({ deliver: false, reason: "unchanged" });
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(), { ...grok, expires_at: "2026-09-19T00:00:00.000Z" }),
      Date.parse("2026-09-17T13:00:00Z"),
    ),
  ).toEqual({ deliver: false, reason: "unchanged" });
});

test("quota changes require a whole percentage and five minutes, coalescing during cooldown", () => {
  const previous = baseline();
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(20.9), grok),
      Date.parse("2026-09-17T12:10:00Z"),
    ),
  ).toEqual({ deliver: false, reason: "subthreshold" });
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(21), grok),
      Date.parse("2026-09-17T12:04:59Z"),
    ),
  ).toEqual({ deliver: false, reason: "cooldown" });
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(22), grok),
      Date.parse("2026-09-17T12:05:00Z"),
    ),
  ).toEqual({ deliver: true, reason: "usage_change" });
});

test("eligibility and catalog drift trigger immediately inside quota cooldown", () => {
  const previous = baseline();
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(20.2, false), grok),
      Date.parse("2026-09-17T12:00:10Z"),
    ),
  ).toEqual({ deliver: true, reason: "decision_change" });
  expect(
    planRoutingTurn(
      previous,
      routingCandidate(context(), {
        ...grok,
        drift: [{ code: "unreviewed_live_model", subject: "grok-next", account_key: "grok-2" }],
      }),
      Date.parse("2026-09-17T12:00:10Z"),
    ),
  ).toEqual({ deliver: true, reason: "decision_change" });
});

test("accepted delivery baseline survives a store reopen and contains only the projected allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-routing-delivery-"));
  try {
    const value = baseline();
    const first = new FileRoutingDeliveryStore(root);
    first.write(value);
    first.writeAttempt({
      schemaVersion: 1,
      streamId: "stream",
      attemptedAt: "2026-09-17T12:00:00.000Z",
      candidateDigest: value.candidateDigest,
      producerGeneration: 1,
      contextRevision: 1,
      contextDigest: value.contextDigest,
    });
    const loaded = new FileRoutingDeliveryStore(root).read("stream");
    expect(loaded).toEqual(value);
    expect(new FileRoutingDeliveryStore(root).readAttempt("stream")).toMatchObject({
      candidateDigest: value.candidateDigest,
      contextRevision: 1,
    });
    expect(JSON.stringify(loaded)).not.toContain("email");
    expect(JSON.stringify(loaded)).not.toContain("access_token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
