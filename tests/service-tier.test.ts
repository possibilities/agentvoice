import { describe, expect, test } from "bun:test";
import { observeTier, ServiceTierSelection, tierLabel } from "../src/core/service-tier.ts";
import { parseArgs, parseConsoleCommand } from "../src/main.ts";
import {
  deferred,
  NativeStub,
  nativeFullAccess,
  runtimeHarness,
} from "./fixtures/runtime-harness.ts";

const tier = (native: NativeStub, fast?: boolean) =>
  new ServiceTierSelection((m, p) => native.request(m, p), "/work", fast);

describe("native Fast launch policy", () => {
  test("three-state flags, console alias parsing, and conflicts", () => {
    expect(parseArgs([])).not.toHaveProperty("fast");
    expect(parseArgs(["--fast"]).fast).toBe(true);
    expect(parseArgs(["--no-fast"]).fast).toBe(false);
    expect(parseConsoleCommand(["--allow-full-access", "--resume=id", "--fast"])).toMatchObject({
      parsed: { fast: true },
    });
    for (const args of [
      ["--fast", "--no-fast"],
      ["--no-fast", "--fast"],
      ["--fast", "--fast"],
      ["--fast=true"],
      ["--no-fast=false"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });

  test("unset is identical passthrough with no catalog calls; standard explicitly overrides", async () => {
    const native = new NativeStub();
    const params = {
      serviceTier: "flex",
      config: { service_tier: "fast", "features.fast_mode": false },
    };
    expect(await tier(native).prepare(params)).toBe(params);
    expect(await tier(native, false).prepare(params)).toEqual({
      ...params,
      serviceTier: "default",
    });
    expect(native.calls).toEqual([]);
    expect(params.serviceTier).toBe("flex");
  });

  test("catalog-driven Fast overrides tier/gate only, preserving model, effort, prompts and config", async () => {
    const native = new NativeStub();
    const params = {
      model: "native-model",
      serviceTier: "flex",
      developerInstructions: "custom",
      config: {
        model_reasoning_effort: "high",
        features: { fast_mode: false, other: true },
        "features.fast_mode": false,
      },
    };
    const selection = tier(native, true);
    expect(await selection.prepare(params)).toEqual({
      ...params,
      serviceTier: "priority",
      config: {
        ...params.config,
        features: { fast_mode: true, other: true },
        "features.fast_mode": true,
      },
    });
    expect(params.config.features.fast_mode).toBe(false);
    await selection.prepare({});
    expect(native.calls.map((c) => c.method)).toEqual(["config/read", "model/list"]);
    expect(native.calls[0]?.params).toEqual({ cwd: "/work", includeLayers: false });
  });

  test("uses the advertised Fast ID, not a model name table", async () => {
    const native = new NativeStub();
    native.models = [
      {
        model: "brand-new-model",
        isDefault: true,
        serviceTiers: [{ id: "new-tier", name: "FAST" }],
      },
    ];
    native.nativeConfig = {};
    expect(await tier(native, true).prepare({})).toMatchObject({ serviceTier: "new-tier" });
  });

  test("resumed model metadata wins over global model unless native model overrides are supplied", async () => {
    const native = new NativeStub();
    const selection = tier(native, true);
    const saved = { model: "slow-model", modelProvider: "openai" };
    await expect(selection.prepare({}, saved)).rejects.toThrow("does not advertise Fast");
    expect(await selection.prepare({ model: "native-model" }, saved)).toHaveProperty(
      "serviceTier",
      "priority",
    );
    expect(
      await selection.prepare({ config: { model_reasoning_effort: "high" } }, saved),
    ).toHaveProperty("serviceTier", "priority");
    await expect(selection.prepare({ config: { model: "slow-model" } })).rejects.toThrow(
      "does not advertise Fast",
    );
  });

  test("rejects unsupported, missing, malformed or wrong-provider capabilities", async () => {
    for (const params of [
      { model: "slow-model" },
      { model: "unknown" },
      { modelProvider: "custom" },
    ])
      await expect(tier(new NativeStub(), true).prepare(params)).rejects.toThrow();
    for (const entry of [
      { model: "native-model" },
      { model: "native-model", serviceTiers: [{ name: "Fast" }] },
    ]) {
      const native = new NativeStub();
      native.models = [entry];
      await expect(tier(native, true).prepare({})).rejects.toThrow();
    }
    const native = new NativeStub();
    native.override = (m) =>
      m === "model/list" ? Promise.reject(new Error("catalog unavailable")) : undefined;
    await expect(tier(native, true).prepare({})).rejects.toThrow("Cannot verify --fast support");
  });

  test("paginates hidden models and refuses broken/repeating pagination", async () => {
    const native = new NativeStub();
    native.override = (m, p) =>
      m === "model/list"
        ? Promise.resolve(
            p["cursor"]
              ? { data: native.models, nextCursor: null }
              : { data: [], nextCursor: "next" },
          )
        : undefined;
    await tier(native, true).prepare({});
    expect(native.calls.filter((c) => c.method === "model/list").map((c) => c.params)).toEqual([
      { includeHidden: true, limit: 100 },
      { includeHidden: true, limit: 100, cursor: "next" },
    ]);
    native.override = (m) =>
      m === "model/list" ? Promise.resolve({ data: [], nextCursor: "loop" }) : undefined;
    await expect(tier(native, true).prepare({})).rejects.toThrow("repeated");
    native.override = (m) =>
      m === "model/list" ? Promise.resolve({ data: [], nextCursor: 12 }) : undefined;
    await expect(tier(native, true).prepare({})).rejects.toThrow("invalid");
  });

  test("verifies returned model/tier, while missing telemetry stays explicitly requested", async () => {
    const selection = tier(new NativeStub(), true);
    const params = await selection.prepare({});
    expect(
      tierLabel(
        await selection.confirm({ model: "native-model", serviceTier: "priority" }, params),
      ),
    ).toBe("Work: Fast");
    expect(tierLabel(await selection.confirm({ model: "native-model" }, params))).toBe(
      "Work: Fast requested",
    );
    for (const response of [
      { model: "slow-model", serviceTier: "priority" },
      { model: "native-model", serviceTier: null },
      { model: "native-model", serviceTier: "default" },
      { serviceTier: "priority" },
    ])
      await expect(selection.confirm(response, params)).rejects.toThrow();
    await expect(
      tier(new NativeStub(), false).confirm(
        { serviceTier: "priority" },
        { serviceTier: "default" },
      ),
    ).rejects.toThrow("did not apply --no-fast");
    expect(tierLabel(observeTier({ serviceTier: "default" }, {}))).toBe("Work: Standard");
    expect(
      tierLabel(
        await tier(new NativeStub(), false).confirm(
          { serviceTier: null },
          { serviceTier: "default" },
        ),
      ),
    ).toBe("Work: Standard");
    expect(tierLabel(observeTier({ serviceTier: "flex" }, {}))).toBe("Work: flex");
    expect(tierLabel(observeTier({ serviceTier: null }, { serviceTier: "priority" }))).toBe(
      "Work: Standard",
    );
  });
});

describe("Fast runtime propagation", () => {
  test("Fast and standard reach continue and Fresh without changing voice requests", async () => {
    for (const fast of [true, false]) {
      const h = runtimeHarness(
        {
          orchestrator: { "service-tier": "flex", extra: { serviceTier: "flex" } },
        },
        { fast },
      );
      h.native.tiers = true;
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        const expected = fast ? "priority" : "default";
        expect(h.runtime.currentReady?.serviceTier).toBe(expected);
        await h.runtime.fresh();
        const starts = h.native.calls.filter(
          (c) => c.method === "thread/start" || c.method === "thread/resume",
        );
        expect(starts).toHaveLength(2);
        expect(starts.every((c) => c.params["serviceTier"] === expected)).toBe(true);
        h.runtime.offer("sdp");
        await Bun.sleep(5);
        const voice = h.native.calls.find((c) => c.method === "thread/realtime/start");
        expect(voice).toBeDefined();
        expect(voice!.params).not.toHaveProperty("serviceTier");
        expect(voice!.params).not.toHaveProperty("config");
      } finally {
        await h.cleanup();
      }
    }
  });

  test("unsupported Fast stops before a thread/turn/voice request and closes the child", async () => {
    const h = runtimeHarness({ orchestrator: { model: "slow-model" } }, { fast: true });
    try {
      await expect(h.runtime.start()).rejects.toThrow("does not advertise Fast");
      expect(
        h.native.calls.some((c) =>
          ["thread/start", "thread/resume", "turn/start", "thread/realtime/start"].includes(
            c.method,
          ),
        ),
      ).toBe(false);
      expect(h.ready).toEqual([]);
      expect(h.native.closes).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("quit during catalog lookup cannot create a late thread", async () => {
    const h = runtimeHarness({}, { fast: true });
    const pending = deferred<unknown>();
    const entered = deferred();
    h.native.override = (m) => {
      if (m === "model/list") {
        entered.resolve();
        return pending.promise;
      }
      return undefined;
    };
    const start = h.runtime.start().catch((e) => e);
    await entered.promise;
    await h.runtime.shutdown();
    pending.resolve({ data: h.native.models, nextCursor: null });
    expect(await start).toBeInstanceOf(Error);
    expect(h.native.calls.some((c) => c.method === "thread/start")).toBe(false);
    await h.cleanup();
  });

  test("native settings updates refresh the displayed tier", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      h.native.options.onNotification("thread/settings/updated", {
        threadId: h.runtime.currentReady!.threadId,
        threadSettings: {
          ...nativeFullAccess,
          sandboxPolicy: nativeFullAccess.sandbox,
          model: "changed",
          serviceTier: "priority",
        },
      });
      expect(h.runtime.currentReady).toMatchObject({ model: "changed", serviceTier: "priority" });
    } finally {
      await h.cleanup();
    }
  });
});
