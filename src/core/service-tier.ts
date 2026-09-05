/** Native launch-tier policy. No flag means no extra RPCs or request overrides. */
export type NativeRequest = (method: string, params: unknown) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface TierObservation {
  model?: string;
  /** Missing is unknown; null is the server reporting no explicit tier. */
  serviceTier?: string | null;
  requestedServiceTier?: string;
}

export function observeTier(result: unknown, params: ObjectValue): TierObservation {
  const response = object(result);
  const tier = response["serviceTier"];
  return {
    model: string(response["model"]),
    ...(tier === null || typeof tier === "string" ? { serviceTier: tier } : {}),
    requestedServiceTier: string(params["serviceTier"]),
  };
}

export function tierLabel(
  observation: Pick<TierObservation, "serviceTier" | "requestedServiceTier">,
): string | undefined {
  const label = (tier: string) =>
    tier === "priority" || tier === "fast" ? "Fast" : tier === "default" ? "Standard" : tier;
  if (observation.serviceTier !== undefined)
    return `Work: ${observation.serviceTier === null ? "Standard" : label(observation.serviceTier)}`;
  if (observation.requestedServiceTier)
    return `Work: ${label(observation.requestedServiceTier)} requested`;
  return undefined;
}

interface Catalog {
  config: ObjectValue;
  models: ObjectValue[];
  provider: string;
}

/** One instance per owned Codex child; model capabilities come from that child's catalog. */
export class ServiceTierSelection {
  private catalog: Promise<Catalog> | undefined;

  constructor(
    private readonly request: NativeRequest,
    private readonly workspace: string,
    private readonly fast: boolean | undefined,
  ) {}

  private async readCatalog(): Promise<Catalog> {
    this.catalog ??= (async () => {
      const response = object(
        await this.request("config/read", { cwd: this.workspace, includeLayers: false }),
      );
      if (
        !response["config"] ||
        typeof response["config"] !== "object" ||
        Array.isArray(response["config"])
      )
        throw new Error("Codex returned no effective config");
      const config = object(response["config"]);
      const models: ObjectValue[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = object(
          await this.request("model/list", {
            includeHidden: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!Array.isArray(page["data"])) throw new Error("Codex returned no model catalog");
        models.push(...page["data"].map(object));
        const next = page["nextCursor"];
        if (next !== null && next !== undefined && (typeof next !== "string" || !next))
          throw new Error("Codex returned an invalid model catalog cursor");
        cursor = string(next);
        if (cursor && seen.has(cursor)) throw new Error("Codex repeated a model catalog cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { config, models, provider: string(config["model_provider"]) ?? "openai" };
    })();
    try {
      return await this.catalog;
    } catch (error) {
      throw new Error(
        `Cannot verify --fast support: ${String(error)}. Omit --fast or check your Codex runtime.`,
      );
    }
  }

  private fastTier(catalog: Catalog, model: string | undefined, provider: string): string {
    if (provider !== catalog.provider)
      throw new Error(
        `Cannot verify --fast for provider ${provider}: Codex's catalog describes ${catalog.provider}. Omit --fast or use that provider in native Codex configuration.`,
      );
    const entry = catalog.models.find((entry) => entry["model"] === model);
    if (!model || !entry)
      throw new Error(
        `Cannot verify --fast: ${model ?? "the selected model"} is not in Codex's catalog. Select an advertised --model or omit --fast.`,
      );
    const tiers = entry["serviceTiers"];
    if (!Array.isArray(tiers))
      throw new Error(
        `Cannot verify --fast for ${model}: this Codex catalog does not report service tiers. Update Codex or omit --fast.`,
      );
    const tier = tiers.map(object).find((tier) => string(tier["name"])?.toLowerCase() === "fast");
    const id = string(tier?.["id"]);
    if (!id)
      throw new Error(
        `Model ${model} does not advertise Fast support. Choose another --model or omit --fast.`,
      );
    return id;
  }

  async prepare(params: ObjectValue, persisted?: ObjectValue): Promise<ObjectValue> {
    if (this.fast === undefined) return params;
    if (!this.fast) return { ...params, serviceTier: "default" };
    const catalog = await this.readCatalog();
    const config = object(params["config"]);
    // Mirrors native has_model_resume_override. Never set a model just to enable Fast.
    const overridesModel =
      params["model"] != null ||
      params["modelProvider"] != null ||
      Object.hasOwn(config, "model") ||
      Object.hasOwn(config, "model_reasoning_effort");
    const saved = overridesModel ? undefined : persisted;
    const model =
      string(params["model"]) ??
      string(config["model"]) ??
      string(saved?.["model"]) ??
      string(catalog.config["model"]) ??
      string(catalog.models.find((m) => m["isDefault"] === true)?.["model"]);
    const provider =
      string(params["modelProvider"]) ??
      string(saved?.["modelProvider"]) ??
      string(config["model_provider"]) ??
      catalog.provider;
    const tier = this.fastTier(catalog, model, provider);
    // Explicit CLI choice wins over both config shapes and extra.serviceTier.
    // Enable only this thread's native gate, never persist to global config.
    return {
      ...params,
      serviceTier: tier,
      config: {
        ...config,
        ...(Object.hasOwn(config, "features")
          ? { features: { ...object(config["features"]), fast_mode: true } }
          : {}),
        "features.fast_mode": true,
      },
    };
  }

  async confirm(result: unknown, params: ObjectValue): Promise<TierObservation> {
    const observation = observeTier(result, params);
    if (this.fast === undefined) return observation;
    const requested = string(params["serviceTier"]);
    if (this.fast) {
      const catalog = await this.readCatalog();
      const actual = this.fastTier(
        catalog,
        observation.model,
        string(object(result)["modelProvider"]) ?? catalog.provider,
      );
      if (actual !== requested)
        throw new Error("Codex selected a different Fast tier; refusing to start work.");
    }
    // With the native Fast feature disabled, core reports null even for an
    // explicit "default" request. Both mean no accelerated tier; missing is unknown.
    const standardWithoutFeature = this.fast === false && observation.serviceTier === null;
    if (
      observation.serviceTier !== undefined &&
      observation.serviceTier !== requested &&
      !standardWithoutFeature
    )
      throw new Error(
        `Codex did not apply ${this.fast ? "--fast" : "--no-fast"}: requested ${requested}, reported ${observation.serviceTier ?? "no tier"}. Check native settings/requirements.`,
      );
    return observation;
  }
}
