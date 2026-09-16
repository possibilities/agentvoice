import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 300_000;
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
export type RoutingCommand = (command: string, args: string[], input?: unknown) => Promise<unknown>;

/** Bounded subprocess seam. Provider private state and command stderr never enter context. */
export const routingCommand: RoutingCommand = (command, args, input) =>
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
    const timer = setTimeout(refuse, 20_000);
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
}

/** One coalescing producer per exact native runtime. Native acceptance is not consumption. */
export class ManagerRoutingOrientation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private pending = false;
  private stopped = false;
  private generation: number | undefined;
  private readonly stream: string;
  private readonly command: RoutingCommand;
  private warned: string | undefined;
  constructor(private readonly options: RoutingOrientationOptions) {
    this.stream = `agentvoice:${hash(options.workspace).slice(0, 24)}:${options.threadId}`;
    this.command = options.command ?? routingCommand;
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
  private async publish(): Promise<void> {
    const state = row(
      await this.command("agenthud", ["routing", "state", "--stream", this.stream]),
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
    const [evidence, models] = await Promise.all([
      this.command("agentusage", ["routing", "evidence", "--json"]),
      this.catalog(),
    ]);
    if (this.stopped) return;
    const now = new Date().toISOString();
    const identity = this.options.identity;
    const input = {
      schema_version: 1,
      producer_generation: this.generation,
      context_revision: revision,
      trigger: revision === 1 ? (expected ? "producer_generation_change" : "initial") : "heartbeat",
      composed_at: now,
      reviewed: { revision: 1, source_version: "agentvoice-role-catalog-2026-09-14" },
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
    if (Array.isArray(drift) && drift.length)
      this.warn(
        "Routing model catalog drift detected. Delegation recommendations are disabled until reviewed guidance is updated.",
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
        "agentvoice-manager",
        "--consumer",
        identity.processInstanceId,
      ]),
    );
    const output = {
      schema_version: 1,
      type: "routing.context",
      stream_id: this.stream,
      manager_id: "agentvoice-manager",
      consumer_id: identity.processInstanceId,
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
      context: delivery["delivery"],
    };
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
    )
      this.warn("Routing context was persisted, but native delivery acknowledgment is unknown.");
  }
}
