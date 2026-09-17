import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type DeliveredRoutingBaseline,
  FileRoutingDeliveryStore,
  MemoryRoutingDeliveryStore,
  planRoutingTurn,
  type RoutingDeliveryStore,
  routingCandidate,
} from "./routing-delivery.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 60_000;
const GROK_REFRESH_TIMEOUT_MS = 65_000;
const GROK_MIN_VALIDITY_MS = 30_000;
const ROUTING_MANAGER_ID = "agentvoice-manager";
const ROUTING_CONSUMER_ID = "agentvoice-routing-turns";
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface RoutingIdentity {
  controllerId: string;
  generation: number;
  processInstanceId: string;
  buildId: string;
}
/** Compatible activation from a retained controller predating the identity field. */
export function routingIdentityFromStatus(
  value: unknown,
  threadId: string,
): RoutingIdentity | undefined {
  const status = row(value),
    runtime = row(status["runtime"]);
  if (
    typeof status["instanceId"] !== "string" ||
    !status["instanceId"] ||
    status["threadId"] !== threadId ||
    !Number.isSafeInteger(status["generation"]) ||
    Number(status["generation"]) < 1 ||
    !Number.isSafeInteger(runtime["pid"]) ||
    Number(runtime["pid"]) < 1 ||
    typeof runtime["buildId"] !== "string" ||
    !runtime["buildId"]
  )
    return undefined;
  return {
    controllerId: status["instanceId"],
    generation: Number(status["generation"]),
    processInstanceId: `${status["instanceId"]}:${status["generation"]}:${runtime["pid"]}`,
    buildId: runtime["buildId"],
  };
}
export type RoutingCommand = (
  command: string,
  args: string[],
  input?: unknown,
  timeoutMs?: number,
) => Promise<unknown>;

/** Bounded subprocess seam. Provider private state and command stderr never enter context. */
export const routingCommand: RoutingCommand = (command, args, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const refuse = () => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(new Error("routing_command_unavailable"));
    };
    const timer = setTimeout(refuse, timeoutMs ?? 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) refuse();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", refuse);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        refuse();
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        refuse();
      }
    });
    child.stdin.on("error", refuse);
    const text = input === undefined ? "" : JSON.stringify(input);
    if (Buffer.byteLength(text) > MAX_BYTES) {
      refuse();
      return;
    }
    child.stdin.end(text);
  });

export interface RoutingOrientationOptions {
  identity: RoutingIdentity;
  workspace: string;
  clientVersion: string;
  threadId: string;
  current(): { model: string | null; effort: string | null; service_tier: string | null };
  request(method: string, params: unknown, timeout?: number): Promise<unknown>;
  warning(message: string): void;
  command?: RoutingCommand;
  intervalMs?: number;
  stateDir?: string;
  deliveryStore?: RoutingDeliveryStore;
  now?: () => number;
}

/** One coalescing producer per exact native runtime with a restart-safe accepted-delivery baseline. */
export class ManagerRoutingOrientation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private pending = false;
  private stopped = false;
  private generation: number | undefined;
  private readonly stream: string;
  private readonly command: RoutingCommand;
  private readonly deliveryStore: RoutingDeliveryStore;
  private delivered: DeliveredRoutingBaseline | null | undefined;
  private attempted: ReturnType<RoutingDeliveryStore["readAttempt"]> | undefined;
  private warned: string | undefined;
  constructor(private readonly options: RoutingOrientationOptions) {
    this.stream = `agentvoice:${hash(options.workspace).slice(0, 24)}:${options.threadId}`;
    this.command = options.command ?? routingCommand;
    this.deliveryStore =
      options.deliveryStore ??
      (options.stateDir
        ? new FileRoutingDeliveryStore(options.stateDir)
        : new MemoryRoutingDeliveryStore());
  }
  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.options.intervalMs ?? REFRESH_MS);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer) clearInterval(this.timer);
  }
  refresh(): void {
    if (this.stopped) return;
    this.pending = true;
    if (!this.running) void this.drain();
  }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending && !this.stopped) {
        this.pending = false;
        try {
          await this.publish();
        } catch {
          this.warn(
            "Routing context unavailable; account delegation requires fresh owner evidence.",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
  private warn(message: string): void {
    if (this.warned !== message) {
      this.warned = message;
      this.options.warning(message);
    }
  }
  private async catalog(): Promise<Row[]> {
    const models: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = row(
        await this.options.request(
          "model/list",
          { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) },
          10_000,
        ),
      );
      if (!Array.isArray(page["data"]) || models.length + page["data"].length > 256)
        throw new Error("catalog_unavailable");
      for (const raw of page["data"]) {
        const item = row(raw);
        const model = item["model"];
        if (
          typeof model !== "string" ||
          !Array.isArray(item["supportedReasoningEfforts"]) ||
          !Array.isArray(item["serviceTiers"])
        )
          throw new Error("catalog_unavailable");
        models.push({
          model,
          efforts: item["supportedReasoningEfforts"].map((value) => row(value)["reasoningEffort"]),
          service_tiers: item["serviceTiers"].map((value) => row(value)["id"]),
          hidden: item["hidden"],
          default_effort: item["defaultReasoningEffort"],
          default_service_tier: item["defaultServiceTier"] ?? null,
          is_default: item["isDefault"],
          multi_agent_version: item["multiAgentVersion"] ?? null,
          input_modalities: item["inputModalities"],
        });
      }
      const next = page["nextCursor"];
      if (
        next !== null &&
        next !== undefined &&
        (typeof next !== "string" || !next || seen.has(next))
      )
        throw new Error("catalog_unavailable");
      cursor = typeof next === "string" ? next : undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return models;
  }
  private async routingEvidence(): Promise<{ evidence: Row; grokCatalog: Row }> {
    const evidence = row(await this.command("agentusage", ["routing", "evidence", "--json"]));
    const evidenceRevision = evidence["source_revision"];
    if (
      !(
        (typeof evidenceRevision === "string" && /^[1-9]\d{0,63}$/u.test(evidenceRevision)) ||
        (Number.isSafeInteger(evidenceRevision) && Number(evidenceRevision) > 0)
      )
    )
      throw new Error("routing_evidence_unavailable");
    const grokCatalog = row(
      await this.command("agentusage", [
        "routing",
        "grok-catalog",
        "--expected-source-revision",
        String(evidenceRevision),
        "--json",
      ]),
    );
    if (grokCatalog["source_revision"] !== String(evidenceRevision))
      throw new Error("grok_catalog_revision_conflict");
    return { evidence, grokCatalog };
  }
  private grokCatalogNeedsRefresh(catalog: Row): boolean {
    const visibility = row(catalog["visibility"]);
    if (visibility["complete"] !== true || !Array.isArray(visibility["accounts"])) return true;
    if (visibility["accounts"].length === 0) return false;
    if (
      visibility["accounts"].some((value) => {
        const account = row(value);
        return (
          account["fresh"] !== true ||
          account["credential_current"] !== true ||
          account["error_code"] !== null
        );
      })
    )
      return true;
    const expiresAt = catalog["expires_at"];
    return (
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now() + GROK_MIN_VALIDITY_MS
    );
  }
  private async convergedRoutingEvidence(): Promise<{ evidence: Row; grokCatalog: Row }> {
    let current: { evidence: Row; grokCatalog: Row } | undefined;
    try {
      current = await this.routingEvidence();
      if (!this.grokCatalogNeedsRefresh(current.grokCatalog)) return current;
    } catch {
      // A missing Grok sidecar is recoverable through the same owned refresh below.
    }
    try {
      await this.command(
        "agentusage",
        ["refresh", "grok", "--json"],
        undefined,
        GROK_REFRESH_TIMEOUT_MS,
      );
    } catch {
      // Re-read last-good evidence after any failed or unknown refresh outcome.
    }
    return this.routingEvidence();
  }
  private async publish(): Promise<void> {
    const state = row(
      await this.command("agenthud", [
        "routing",
        "state",
        "--stream",
        this.stream,
        "--manager",
        ROUTING_MANAGER_ID,
        "--consumer",
        ROUTING_CONSUMER_ID,
      ]),
    );
    const publication = row(state["publication"]);
    const previous = row(publication["context"]);
    const sources = row(previous["sources"]);
    if (this.generation === undefined)
      this.generation = Number(previous["producer_generation"] ?? 0) + 1;
    const expected = publication["context"]
      ? {
          producer_generation: previous["producer_generation"],
          context_revision: previous["context_revision"],
          digest: previous["digest"],
        }
      : null;
    const revision =
      previous["producer_generation"] === this.generation
        ? Number(previous["context_revision"]) + 1
        : 1;
    const [{ evidence, grokCatalog }, models] = await Promise.all([
      this.convergedRoutingEvidence(),
      this.catalog(),
    ]);
    if (this.stopped) return;
    const nowMs = this.options.now?.() ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const identity = this.options.identity;
    const input = {
      schema_version: 1,
      producer_generation: this.generation,
      context_revision: revision,
      trigger:
        revision === 1 ? (expected ? "producer_generation_change" : "initial") : "material_change",
      composed_at: now,
      reviewed: {
        revision: 2,
        source_version: "agentvoice-role-catalog-and-economics-2026-09-16",
      },
      native_catalog: {
        revision: Number(sources["native_catalog_revision"] ?? 0) + 1,
        source: "codex_app_server_model_list",
        client_version: this.options.clientVersion,
        capture_id: `native-${Date.now()}`,
        observed_at: now,
        models,
      },
      current: {
        ...this.options.current(),
        native: {
          process_instance_id: identity.processInstanceId,
          runtime_build_id: identity.buildId,
          session_id: this.options.threadId,
        },
      },
      host_control: {
        host_revision: Number(sources["hud_host_revision"] ?? 0) + 1,
        domain_revision: Number(sources["hud_domain_revision"] ?? 0) + 1,
        host_id: "agentvoice",
        server_id: identity.controllerId,
        history_namespace: hash(this.options.workspace),
        host_incarnation: identity.processInstanceId,
        domain_id: identity.controllerId,
        controller_id: identity.controllerId,
        control_epoch: identity.generation,
        target: { kind: "codex_root", id: this.options.threadId },
        scope_id: this.stream,
        allowed_actions: ["start", "steer", "interrupt"],
      },
      evidence,
    };
    const context = row(
      await this.command(
        "agentusage",
        ["routing", "compose-native", "--file", "-", "--json"],
        input,
      ),
    );
    if (this.stopped) return;
    if (this.delivered === undefined) this.delivered = this.deliveryStore.read(this.stream);
    const candidate = routingCandidate(context, grokCatalog);
    const plan = planRoutingTurn(this.delivered ?? null, candidate, nowMs);
    if (!plan.deliver) return;
    if (this.attempted === undefined) this.attempted = this.deliveryStore.readAttempt(this.stream);
    if (this.attempted?.candidateDigest === candidate.candidateDigest) return;
    await this.command("agenthud", ["routing", "apply", "--file", "-"], {
      action: "publication.publish",
      operationId: `routing-${identity.processInstanceId}-${revision}`,
      actor: "agentvoice",
      streamId: this.stream,
      expected,
      evidence,
      context,
    });
    const drift = row(context["native_catalog"])["drift"];
    const grokDrift = grokCatalog["drift"];
    if (Array.isArray(drift) && drift.length)
      this.warn(
        "Routing model catalog drift detected. Delegation recommendations are disabled until reviewed guidance is updated.",
      );
    else if (Array.isArray(grokDrift) && grokDrift.length)
      this.warn(
        "Grok catalog drift detected. Only live models with reviewed metadata and fresh included quota are routable.",
      );
    else this.warned = undefined;
    if (this.stopped || this.pending) return;
    const delivery = row(
      await this.command("agenthud", [
        "routing",
        "state",
        "--stream",
        this.stream,
        "--manager",
        ROUTING_MANAGER_ID,
        "--consumer",
        ROUTING_CONSUMER_ID,
      ]),
    );
    const routingPolicy = row(row(context["guidance"])["routing_policy"]);
    const routingGuidance =
      routingPolicy["enabled"] === true
        ? {
            provider_preference:
              "When fresh context lists an eligible Grok account and AgentFX advertises a compatible Grok target, prefer it for a well-specified assignment to preserve finite Codex main quota.",
            codex_selection:
              "For Codex work, choose the least expensive reviewed model adequate for the task; task fit and current native target support remain required.",
            economics_boundary:
              "Codex model prices are an official API text-token proxy within OpenAI only. They do not measure subscription quota or establish any numeric Codex-to-Grok comparison.",
            grok_selection:
              "Use grok_catalog.routable only. Its default model is the reviewed preference among live compatible models with fresh included quota; visibility also retains intentionally excluded and review-required live models.",
          }
        : undefined;
    const output = {
      schema_version: 1,
      type: "routing.context",
      stream_id: this.stream,
      manager_id: ROUTING_MANAGER_ID,
      consumer_id: ROUTING_CONSUMER_ID,
      handling: {
        human_facing_response: "none",
        start_new_work: false,
        description:
          "Background routing facts only. Use on the next authorized delegation; preserve current work. Do not speak or send a progress message merely because this refresh arrived. Native current-account correlation and numeric economics may be unavailable. Publication and native delivery are not acknowledgment of consumption.",
      },
      delegation: {
        command: "agentfx",
        config: "~/.config/agentfx/quota-routing.json",
        operations: ["targets", "start", "observe", "steer", "cancel", "collect"],
        note: "MCP targets/start/observe/control or bounded run --config FILE --file REQUEST. Require fresh routing_source_revision, explicit target/effort, existing Work and routing-decision association; no uncontrolled fanout.",
      },
      ...(routingGuidance ? { routing_guidance: routingGuidance } : {}),
      grok_catalog: grokCatalog,
      context: delivery["delivery"],
    };
    const attempt = {
      schemaVersion: 1 as const,
      streamId: this.stream,
      attemptedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      candidateDigest: candidate.candidateDigest,
      producerGeneration: Number(context["producer_generation"]),
      contextRevision: Number(context["context_revision"]),
      contextDigest: String(context["digest"]),
    };
    this.deliveryStore.writeAttempt(attempt);
    this.attempted = attempt;
    // At most one native submission per persisted revision; unknown outcomes are never retried.
    const accepted = row(
      await this.options.request(
        "turn/start",
        {
          threadId: this.options.threadId,
          input: [],
          toolOutput: {
            namespace: "agentusage",
            name: "routing_context",
            output: JSON.stringify(output),
          },
        },
        10_000,
      ),
    );
    const turn = row(accepted["turn"]);
    if (
      typeof turn["id"] !== "string" ||
      !turn["id"] ||
      turn["id"].length > 128 ||
      turn["status"] !== "inProgress"
    ) {
      this.warn("Routing context was persisted, but native delivery acknowledgment is unknown.");
      return;
    }
    const payload = row(delivery["delivery"]);
    const mode = payload["mode"];
    if (
      (mode !== "full" && mode !== "delta") ||
      !Number.isSafeInteger(payload["producer_generation"]) ||
      !Number.isSafeInteger(payload["context_revision"]) ||
      typeof payload["digest"] !== "string" ||
      typeof payload["delivery_digest"] !== "string"
    ) {
      this.warn("Routing context was delivered, but its persistent receipt was invalid.");
      return;
    }
    const observedAt = context["observed_at"];
    const expiresAt = context["expires_at"];
    if (typeof observedAt !== "string" || typeof expiresAt !== "string") {
      this.warn("Routing context was delivered, but its freshness receipt was invalid.");
      return;
    }
    const baseline: DeliveredRoutingBaseline = {
      schemaVersion: 1,
      streamId: this.stream,
      deliveredAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      turnId: turn["id"],
      producerGeneration: Number(payload["producer_generation"]),
      contextRevision: Number(payload["context_revision"]),
      contextDigest: payload["digest"],
      deliveryMode: mode,
      observedAt,
      expiresAt,
      controllerId: identity.controllerId,
      controllerGeneration: identity.generation,
      threadId: this.options.threadId,
      runtimeBuildId: identity.buildId,
      ...candidate,
    };
    this.deliveryStore.write(baseline);
    this.delivered = baseline;
    const consumer = row(delivery["consumer"]);
    const expectedRevision = Number.isSafeInteger(consumer["revision"])
      ? Number(consumer["revision"])
      : 0;
    try {
      await this.command("agenthud", ["routing", "apply", "--file", "-"], {
        action: "consumer.consume",
        operationId: `routing-consume-${identity.processInstanceId}-${baseline.producerGeneration}-${baseline.contextRevision}`,
        actor: ROUTING_MANAGER_ID,
        streamId: this.stream,
        managerId: ROUTING_MANAGER_ID,
        expectedRevision,
        receipt: {
          schema_version: 1,
          consumer_id: ROUTING_CONSUMER_ID,
          producer_generation: baseline.producerGeneration,
          context_revision: baseline.contextRevision,
          context_digest: baseline.contextDigest,
          delivery_digest: payload["delivery_digest"],
          delivery_mode: mode,
          consumed_at: baseline.deliveredAt,
        },
      });
    } catch {
      this.warn(
        "Routing context was delivered, but its durable consumption receipt is unavailable.",
      );
    }
  }

  /** Read-only projection of the last authoritatively accepted native delivery. */
  readContext(): unknown {
    if (this.delivered === undefined) this.delivered = this.deliveryStore.read(this.stream);
    const baseline = this.delivered;
    if (!baseline)
      return {
        schema_version: 1,
        status: "unavailable",
        stream_id: this.stream,
        reason: "no_authoritative_delivery",
      };
    const checkedAtMs = this.options.now?.() ?? Date.now();
    const expiresAtMs = Date.parse(baseline.expiresAt);
    const currentFence =
      baseline.controllerId === this.options.identity.controllerId &&
      baseline.controllerGeneration === this.options.identity.generation &&
      baseline.threadId === this.options.threadId &&
      baseline.runtimeBuildId === this.options.identity.buildId;
    return {
      schema_version: 1,
      status: "available",
      stream_id: baseline.streamId,
      revision: {
        producer_generation: baseline.producerGeneration,
        context_revision: baseline.contextRevision,
        digest: baseline.contextDigest,
      },
      freshness: {
        state: Number.isFinite(expiresAtMs) && checkedAtMs < expiresAtMs ? "fresh" : "stale",
        observed_at: baseline.observedAt,
        expires_at: baseline.expiresAt,
        checked_at: new Date(checkedAtMs).toISOString(),
      },
      fence: {
        controller_id: baseline.controllerId,
        controller_generation: baseline.controllerGeneration,
        thread_id: baseline.threadId,
        runtime_build_id: baseline.runtimeBuildId,
        matches_current_runtime: currentFence,
      },
      delivery: {
        mode: "full",
        source_mode: baseline.deliveryMode,
        delivered_at: baseline.deliveredAt,
        turn_id: baseline.turnId,
        note: "Explicit queries return a self-contained full projection. Background sequential updates may use delta transcript cards.",
      },
      context: baseline.view,
    };
  }
}
