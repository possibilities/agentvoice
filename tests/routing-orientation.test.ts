import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRoutingDeliveryStore,
  MemoryRoutingDeliveryStore,
} from "../src/core/routing-delivery.ts";
import {
  ManagerRoutingOrientation,
  type RoutingCommand,
  type RoutingOrientationOptions,
  routingIdentityFromStatus,
} from "../src/core/routing-orientation.ts";

const catalog = {
  data: [
    {
      model: "gpt-5.6-sol",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      serviceTiers: [{ id: "priority" }],
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      isDefault: true,
      inputModalities: ["text"],
      multiAgentVersion: null,
    },
  ],
  nextCursor: null,
};
function fixture(
  overrides: Partial<RoutingOrientationOptions> = {},
  contextOverrides: Record<string, unknown> | (() => Record<string, unknown>) = {},
  grokOverrides: Record<string, unknown> = {},
  behavior: { expiredGrokCatalog?: boolean; grokRefreshFails?: boolean } = {},
) {
  const calls: { command: string; args: string[]; input?: unknown; timeoutMs?: number }[] = [];
  const native: { method: string; params: unknown }[] = [];
  const warnings: string[] = [];
  let publication: Record<string, unknown> | null = null;
  let consumer: Record<string, unknown> | null = null;
  let resolve: () => void = () => {};
  const delivered = new Promise<void>((r) => {
    resolve = r;
  });
  let grokRefreshed = false;
  const initialRevision = "6405175911611332984741815";
  const refreshedRevision = "6405175911611332984741816";
  const command: RoutingCommand = async (command, args, input, timeoutMs) => {
    calls.push({ command, args, input, timeoutMs });
    if (command === "agentusage" && args[0] === "refresh") {
      if (behavior.grokRefreshFails) throw new Error("refresh failed");
      grokRefreshed = true;
      return { schema_version: 1, grok: { outcome: "refreshed", health: "ok" } };
    }
    if (command === "agentusage" && args[1] === "evidence")
      return {
        schema_version: 2,
        source_revision: grokRefreshed ? refreshedRevision : initialRevision,
      };
    if (command === "agentusage" && args[1] === "grok-catalog")
      return {
        schema_version: 1,
        source_revision: grokRefreshed ? refreshedRevision : initialRevision,
        status: behavior.expiredGrokCatalog && !grokRefreshed ? "drift" : "ok",
        expires_at:
          behavior.expiredGrokCatalog && !grokRefreshed
            ? "2020-01-01T00:00:00.000Z"
            : "2099-01-01T00:00:00.000Z",
        drift:
          behavior.expiredGrokCatalog && !grokRefreshed
            ? [{ code: "catalog_stale", subject: "grok-2", account_key: "grok-2" }]
            : [],
        visibility: {
          complete: true,
          accounts: behavior.expiredGrokCatalog
            ? [
                {
                  account_key: "grok-2",
                  fresh: grokRefreshed,
                  credential_current: true,
                  error_code: null,
                },
              ]
            : [],
        },
        routable: {
          default_model: behavior.expiredGrokCatalog && !grokRefreshed ? null : "grok-4.6",
          models: behavior.expiredGrokCatalog && !grokRefreshed ? [] : [{ model: "grok-4.6" }],
        },
        ...grokOverrides,
      };
    if (command === "agentusage") {
      const value = input as Record<string, unknown>;
      const resolvedContextOverrides =
        typeof contextOverrides === "function" ? contextOverrides() : contextOverrides;
      return {
        schema_version: 2,
        producer_generation: value["producer_generation"],
        context_revision: value["context_revision"],
        digest: "a".repeat(64),
        sources: { native_catalog_revision: 1, hud_host_revision: 1, hud_domain_revision: 1 },
        native_catalog: { drift: [] },
        current: {
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: "medium",
          service_tier: "priority",
        },
        guidance: {
          task_fit: ["implementation"],
          routing_policy: { enabled: true, codex_cost_order: ["gpt-5.6-sol"] },
        },
        quota: {
          source_revision: initialRevision,
          eligible_account_keys: [],
          delegation_available: false,
          accounts: [],
          grok: [],
        },
        observed_at: "2026-09-16T12:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        ...resolvedContextOverrides,
      };
    }
    if (args[1] === "apply") {
      const mutation = input as Record<string, unknown>;
      if (mutation["action"] === "publication.publish") {
        publication = { context: mutation["context"] };
        return { published: true };
      }
      consumer = { revision: 1, receipt: mutation["receipt"] };
      return { published: false };
    }
    const context = publication?.["context"] as Record<string, unknown> | undefined;
    return {
      publication,
      delivery: publication
        ? {
            mode: "full",
            producer_generation: context?.["producer_generation"],
            context_revision: context?.["context_revision"],
            digest: context?.["digest"],
            delivery_digest: "b".repeat(64),
            payload: publication["context"],
          }
        : null,
      consumer,
    };
  };
  const options: RoutingOrientationOptions = {
    identity: {
      controllerId: "controller-1",
      generation: 1,
      processInstanceId: "runtime-1",
      buildId: "build-1",
    },
    workspace: "/workspace",
    clientVersion: "test-client-1",
    threadId: "thread-1",
    current: () => ({ model: "gpt-5.6-sol", effort: "medium", service_tier: "priority" }),
    command,
    warning: (message) => warnings.push(message),
    request: async (method, params) => {
      native.push({ method, params });
      if (method === "model/list") return catalog;
      resolve();
      return { turn: { id: "turn-1", status: "inProgress" } };
    },
    ...overrides,
  };
  return {
    orientation: new ManagerRoutingOrientation(options),
    calls,
    native,
    warnings,
    delivered,
    options,
  };
}

function quotaContext(usedPercent: number, eligible = true) {
  return {
    quota: {
      source_revision: "6405175911611332984741815",
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
test("orientation publishes exact runtime/catalog facts, submits one silent output, and records accepted delivery", async () => {
  const f = fixture();
  f.orientation.start();
  await f.delivered;
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.orientation.stop();
  const compose = f.calls.find((call) => call.args[1] === "compose-native")!;
  expect(compose.input).toMatchObject({
    current: {
      model: "gpt-5.6-sol",
      effort: "medium",
      service_tier: "priority",
      native: { session_id: "thread-1", process_instance_id: "runtime-1" },
    },
    evidence: { source_revision: "6405175911611332984741815" },
    reviewed: {
      revision: 2,
      source_version: "agentvoice-role-catalog-and-economics-2026-09-16",
    },
    native_catalog: { source: "codex_app_server_model_list" },
  });
  expect(f.calls.filter((call) => call.args[1] === "apply")).toHaveLength(2);
  expect(JSON.stringify(f.calls)).toContain("consumer.consume");
  const start = f.native.find((call) => call.method === "turn/start")!.params as {
    toolOutput: { namespace: string; name: string; output: string };
  };
  expect(start.toolOutput.namespace).toBe("agentusage");
  expect(start.toolOutput.name).toBe("routing_context");
  expect(JSON.parse(start.toolOutput.output).handling).toMatchObject({
    human_facing_response: "none",
    start_new_work: false,
  });
  const output = JSON.parse(start.toolOutput.output);
  expect(output.delegation).toEqual({
    command: "agentfx",
    config: "~/.config/agentfx/quota-routing.json",
    operations: ["targets", "start", "resume", "observe", "control"],
    control_actions: ["steer", "cancel", "close"],
    task_identity:
      "Prepare the AgentHUD Assignment first and pass its exact taskName as AgentFX task_slug.",
    routing_source_revision: {
      ordinary_fixed_target: "broker_prepare",
      aggregate_context_revision:
        "Orientation and optional exact-fence evidence only; it is not a durable launch ticket.",
      exact_fence:
        "Pass an exact aggregate source revision only when intentionally fencing admission to that exact snapshot.",
    },
    note: "Call targets, choose an explicit compatible target_id after verifying its provider/model, and pass an explicit effort plus exact Work, Assignment, routing-decision and invoker associations. Preserve idempotency keys, inspect observation before any retry, and never silently fall back.",
  });
  expect(output.delegation.operations).not.toContain("collect");
  expect(output.routing_guidance).toEqual({
    provider_preference:
      "When fresh context lists an eligible Grok account and AgentFX advertises a compatible Grok target, prefer it for a well-specified assignment to preserve finite Codex main quota.",
    codex_selection:
      "For Codex work, choose the least expensive reviewed model adequate for the task; task fit and current native target support remain required.",
    economics_boundary:
      "Codex model prices are an official API text-token proxy within OpenAI only. They do not measure subscription quota or establish any numeric Codex-to-Grok comparison.",
    grok_selection:
      "Use grok_catalog.routable only. Its default model is the reviewed preference among live compatible models with fresh included quota; visibility also retains intentionally excluded and review-required live models.",
  });
  expect(output.grok_catalog).toMatchObject({
    source_revision: "6405175911611332984741815",
    routable: { default_model: "grok-4.6" },
  });
  expect(f.calls.find((call) => call.args[1] === "grok-catalog")?.args).toEqual([
    "routing",
    "grok-catalog",
    "--expected-source-revision",
    "6405175911611332984741815",
    "--json",
  ]);
  const queried = f.orientation.readContext() as Record<string, unknown>;
  expect(queried).toMatchObject({
    schema_version: 1,
    status: "available",
    revision: { producer_generation: 1, context_revision: 1, digest: "a".repeat(64) },
    fence: { matches_current_runtime: true, thread_id: "thread-1" },
    delivery: { mode: "full", source_mode: "full" },
    context: { current: { model: "gpt-5.6-sol" } },
  });
  expect(JSON.stringify(queried)).not.toContain("email");
  expect(JSON.stringify(queried)).not.toContain("access_token");
});

test("expired Grok catalog refreshes before the exact-revision snapshot is published", async () => {
  const f = fixture({}, {}, {}, { expiredGrokCatalog: true });
  f.orientation.start();
  await f.delivered;
  f.orientation.stop();
  const refresh = f.calls.findIndex(
    (call) => call.command === "agentusage" && call.args[0] === "refresh",
  );
  const evidenceReads = f.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.command === "agentusage" && call.args[1] === "evidence");
  expect(refresh).toBeGreaterThan(evidenceReads[0]!.index);
  expect(refresh).toBeLessThan(evidenceReads[1]!.index);
  expect(f.calls[refresh]).toMatchObject({
    args: ["refresh", "grok", "--json"],
    timeoutMs: 65_000,
  });
  const start = f.native.find((call) => call.method === "turn/start")!.params as {
    toolOutput: { output: string };
  };
  expect(JSON.parse(start.toolOutput.output).grok_catalog).toMatchObject({
    source_revision: "6405175911611332984741816",
    status: "ok",
    routable: { default_model: "grok-4.6" },
  });
});

test("failed Grok refresh preserves and delivers explicit stale drift", async () => {
  const f = fixture({}, {}, {}, { expiredGrokCatalog: true, grokRefreshFails: true });
  f.orientation.start();
  await f.delivered;
  f.orientation.stop();
  expect(f.warnings).toEqual([
    "Grok catalog drift detected. Only live models with reviewed metadata and fresh included quota are routable.",
  ]);
  const start = f.native.find((call) => call.method === "turn/start")!.params as {
    toolOutput: { output: string };
  };
  expect(JSON.parse(start.toolOutput.output).grok_catalog).toMatchObject({
    status: "drift",
    routable: { default_model: null, models: [] },
    drift: [{ code: "catalog_stale", account_key: "grok-2" }],
  });
});
test("stopped producer fences a pending catalog capture from publication or native work", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const f = fixture({
    request: async () => {
      await hold;
      return catalog;
    },
  });
  f.orientation.start();
  f.orientation.stop();
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(f.calls.some((call) => call.args[1] === "apply")).toBe(false);
  expect(f.native).toHaveLength(0);
});
test("malformed catalog fails closed with a deduplicated warning and no native turn", async () => {
  const f = fixture({
    request: async () => ({ data: [{ model: "ambiguous" }], nextCursor: null }),
  });
  f.orientation.start();
  await new Promise((r) => setTimeout(r, 20));
  f.orientation.refresh();
  await new Promise((r) => setTimeout(r, 20));
  f.orientation.stop();
  expect(f.warnings).toHaveLength(1);
  expect(f.calls.some((call) => call.args[1] === "apply")).toBe(false);
});

test("catalog drift persists context without delivering routing recommendations", async () => {
  const f = fixture(
    {},
    {
      guidance: { routing_policy: { enabled: false } },
      native_catalog: { drift: ["effort-mismatch:gpt-5.6-luna"] },
    },
  );
  f.orientation.start();
  await f.delivered;
  f.orientation.stop();
  const start = f.native.find((call) => call.method === "turn/start")!.params as {
    toolOutput: { output: string };
  };
  expect(JSON.parse(start.toolOutput.output).routing_guidance).toBeUndefined();
  expect(f.warnings).toEqual([
    "Routing model catalog drift detected. Delegation recommendations are disabled until reviewed guidance is updated.",
  ]);
});

test("Grok drift stays visible and warns without disabling independent Codex guidance", async () => {
  const f = fixture(
    {},
    {},
    {
      status: "drift",
      drift: [{ code: "unreviewed_live_model", subject: "grok-next", account_key: "grok-2" }],
    },
  );
  f.orientation.start();
  await f.delivered;
  f.orientation.stop();
  expect(f.warnings).toEqual([
    "Grok catalog drift detected. Only live models with reviewed metadata and fresh included quota are routable.",
  ]);
  const start = f.native.find((call) => call.method === "turn/start")!.params as {
    toolOutput: { output: string };
  };
  expect(JSON.parse(start.toolOutput.output).grok_catalog.drift[0]).toMatchObject({
    subject: "grok-next",
  });
  expect(f.calls.some((call) => call.command === "agentusage" && call.args[0] === "refresh")).toBe(
    false,
  );
});

test("material refreshes coalesce and only the latest persisted revision is submitted", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let catalogs = 0;
  let nativeOutputs = 0;
  let done: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const f = fixture({
    request: async (method) => {
      if (method === "model/list") {
        catalogs++;
        if (catalogs === 1) await hold;
        return catalog;
      }
      nativeOutputs++;
      done();
      return { turn: { id: "latest", status: "inProgress" } };
    },
  });
  f.orientation.start();
  await new Promise((resolve) => setTimeout(resolve, 1));
  f.orientation.refresh();
  f.orientation.refresh();
  f.orientation.refresh();
  release();
  await completed;
  f.orientation.stop();
  expect(catalogs).toBe(2);
  expect(nativeOutputs).toBe(1);
  const publications = f.calls.filter((call) => call.args[1] === "apply");
  expect(publications).toHaveLength(2);
  expect(publications[1]?.input).toMatchObject({ context: { context_revision: 2 } });
});

test("a restart suppresses unchanged percentages before publication and turn/start", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-routing-restart-"));
  try {
    const usedPercent = 20;
    const first = fixture({ deliveryStore: new FileRoutingDeliveryStore(root) }, () =>
      quotaContext(usedPercent),
    );
    await first.orientation.refresh();
    first.orientation.stop();
    const restarted = fixture(
      { deliveryStore: new FileRoutingDeliveryStore(root) },
      () => ({
        ...quotaContext(usedPercent, false),
        current: {
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
          service_tier: "priority",
        },
      }),
      {
        status: "drift",
        drift: [{ code: "catalog_changed", subject: "grok", account_key: null }],
      },
    );
    await restarted.orientation.refresh();
    restarted.orientation.stop();
    expect(
      restarted.calls.filter(
        (call) =>
          call.args[1] === "apply" &&
          (call.input as Record<string, unknown>)?.["action"] === "publication.publish",
      ),
    ).toHaveLength(0);
    expect(restarted.native.filter((call) => call.method === "turn/start")).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cooldown coalesces changed percentages and emits the latest value at the first eligible poll", async () => {
  const store = new MemoryRoutingDeliveryStore();
  const startedAt = Date.parse("2026-09-17T12:00:00.000Z");
  let now = startedAt;
  let usedPercent = 20;
  const f = fixture({ deliveryStore: store, now: () => now }, () => quotaContext(usedPercent));
  await f.orientation.refresh();
  usedPercent = 21;
  now = startedAt + 60_000;
  await f.orientation.refresh();
  usedPercent = 22;
  now = startedAt + 4 * 60_000;
  await f.orientation.refresh();
  expect(f.native.filter((call) => call.method === "turn/start")).toHaveLength(1);
  now = startedAt + 5 * 60_000;
  await f.orientation.refresh();
  f.orientation.stop();
  expect(f.native.filter((call) => call.method === "turn/start")).toHaveLength(2);
  expect(f.orientation.readContext()).toMatchObject({
    delivery: { delivered_at: "2026-09-17T12:05:00.000Z" },
    context: { quota: { accounts: [{ windows: [{ remainingPercent: 78 }] }] } },
  });
});

test("an unknown outcome preserves the accepted baseline and suppresses the attempted percentage across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-routing-unknown-"));
  const startedAt = Date.parse("2026-09-17T12:00:00.000Z");
  let now = startedAt;
  let usedPercent = 20;
  try {
    const accepted = fixture(
      { deliveryStore: new FileRoutingDeliveryStore(root), now: () => now },
      () => quotaContext(usedPercent),
    );
    await accepted.orientation.refresh();
    accepted.orientation.stop();

    usedPercent = 21;
    now = startedAt + 5 * 60_000;
    let starts = 0;
    const unknown = fixture(
      {
        deliveryStore: new FileRoutingDeliveryStore(root),
        now: () => now,
        request: async (method) => {
          if (method === "model/list") return catalog;
          starts++;
          return { turn: { id: "unknown", status: "unknown" } };
        },
      },
      () => quotaContext(usedPercent),
    );
    await unknown.orientation.refresh();
    expect(
      (unknown.orientation.readContext() as Record<string, unknown>)["delivery"],
    ).toMatchObject({
      turn_id: "turn-1",
      delivered_at: "2026-09-17T12:00:00.000Z",
    });
    unknown.orientation.stop();

    const restarted = fixture(
      {
        deliveryStore: new FileRoutingDeliveryStore(root),
        now: () => now,
        request: async (method) => {
          if (method === "model/list") return catalog;
          starts++;
          return { turn: { id: "unexpected", status: "inProgress" } };
        },
      },
      () => quotaContext(usedPercent, false),
    );
    await restarted.orientation.refresh();
    restarted.orientation.stop();
    expect(starts).toBe(1);
    expect(
      unknown.calls.filter(
        (call) =>
          call.args[1] === "apply" &&
          (call.input as Record<string, unknown>)?.["action"] === "publication.publish",
      ),
    ).toHaveLength(1);
    expect(
      restarted.calls.filter(
        (call) =>
          call.args[1] === "apply" &&
          (call.input as Record<string, unknown>)?.["action"] === "publication.publish",
      ),
    ).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained controller compatibility uses authenticated exact runtime/root evidence", () => {
  const status = {
    instanceId: "controller",
    generation: 2,
    threadId: "root",
    runtime: { pid: 123, buildId: "build" },
  };
  expect(routingIdentityFromStatus(status, "root")).toEqual({
    controllerId: "controller",
    generation: 2,
    processInstanceId: "controller:2:123",
    buildId: "build",
  });
  expect(routingIdentityFromStatus(status, "other-root")).toBeUndefined();
  expect(routingIdentityFromStatus({ ...status, runtime: { pid: 123 } }, "root")).toBeUndefined();
});
