import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConnection, appServerArgv } from "../src/core/attach.ts";
import { validateCodexConfig } from "../src/core/codex-config.ts";
import { parseJsonConfig, resolveConfig } from "../src/core/config.ts";
import { loadLaunchConfig, parseArgs, parseConsoleCommand } from "../src/main.ts";
import { nativeFullAccess, runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("native startup configuration", () => {
  test("repeatable aliases preserve order, equals, whitespace and values; --config stays separate", () => {
    const entries = ["model=first", 'model="second = 🎤"', "prompt=", "unknown={ x = [1, 2] }"];
    const parsed = parseArgs([
      "-c",
      entries[0]!,
      `--codex-config=${entries[1]}`,
      `-c=${entries[2]}`,
      "--codex-config",
      entries[3]!,
      "--config",
      "settings.json",
    ]);
    expect(parsed.codexConfig).toEqual(entries);
    expect(parsed.configPath).toBe("settings.json");
    expect(parsed.values).toEqual({});
    expect(parseArgs([])).not.toHaveProperty("codexConfig");
    for (const args of [["-c"], ["--codex-config"], ["-c", "--help"], ["-c", "-c"]])
      expect(() => parseArgs(args)).toThrow("requires a value");
    expect(() => parseArgs(["--model", "a", "--model", "b"])).toThrow("more than once");
    expect(parseConsoleCommand(["-c", "approval_policy=never"])).toMatchObject({ help: false });
    expect(parseConsoleCommand(["--help", "-c", "model=x"])).toEqual({ help: true });
  });

  test("strict optional string array, shape validation, omission and empty array baseline", () => {
    for (const value of [
      null,
      false,
      {},
      "model=x",
      [1],
      [null],
      [""],
      ["missing-equals"],
      [" = x"],
      ["model=x\0"],
      ["--listen=x"],
    ])
      expect(() => parseJsonConfig(JSON.stringify({ "codex-config": value }), "settings")).toThrow(
        "codex-config",
      );
    expect(
      parseJsonConfig('{"codex-config":["x=", "model=bare"]}', "settings")["codex-config"],
    ).toEqual(["x=", "model=bare"]);
    expect(resolveConfig({}, {}, {}, "/test")).not.toHaveProperty("codexConfig");
    expect(resolveConfig({}, { "codex-config": [] }, {}, "/test")).not.toHaveProperty(
      "codexConfig",
    );
    expect(appServerArgv("codex", [])).toEqual(appServerArgv("codex"));
  });

  test("file entries precede CLI entries and paths inside native values are not rewritten", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-startup-config-")));
    const file = ["model=file", 'model_instructions_file="~/custom.md"'];
    const cli = ["model=cli", 'unknown="./relative value"'];
    try {
      writeFileSync(join(root, "settings.json"), JSON.stringify({ "codex-config": file }));
      const config = await loadLaunchConfig(
        parseArgs(["--config", "settings.json", "-c", cli[0]!, "--codex-config", cli[1]!]),
        root,
      );
      expect(config.codexConfig).toEqual([...file, ...cli]);
      expect(config.orchestrator.config).toBeUndefined();
      expect(config.orchestrator.model).toBeUndefined();
      expect(appServerArgv(config.codex, config.codexConfig)).toEqual([
        config.codex,
        "app-server",
        ...[...file, ...cli].flatMap((entry) => ["-c", entry]),
        "--enable",
        "realtime_conversation",
        "--listen",
        "ws://127.0.0.1:0",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("guard final gate choices and accept native permission settings, including nested tables and native bare strings", () => {
    for (const entry of [
      "features.realtime_conversation=false",
      "features={realtime_conversation=false}",
      "features.realtime_conversation.enabled=false",
      "features=false",
      "profiles.voice.features.realtime_conversation=false",
      "cwd=/other",
    ])
      expect(() => validateCodexConfig([entry])).toThrow();
    for (const entries of [
      ["sandbox_mode=read-only"],
      ['approval_policy="on-request"'],
      ["default_permissions=custom"],
      ['profiles={ voice = { approval_policy = "untrusted" } }'],
      ['profiles.voice={sandbox_mode="workspace-write"}'],
      ["profiles.voice.default_permissions=custom"],
      ["approval_policy.granular.mcp=false"],
      [
        "sandbox_mode=danger-full-access",
        "approval_policy='never'",
        "default_permissions=:danger-full-access",
      ],
      ["approval_policy=on-request", "approval_policy=never"],
      ["features.realtime_conversation=false", "features={realtime_conversation=true}"],
      ['profiles.voice={approval_policy="on-request"}', "profiles.voice.approval_policy=never"],
      ['profiles.voice.approval_policy="untrusted"', "profiles={}"],
      ["model=x", "unknown=false", "unknown=", "skills.config=[]"],
      ["__proto__.polluted=true", "profiles.__proto__={}"],
    ])
      expect(() => validateCodexConfig(entries)).not.toThrow();
    expect({}).not.toHaveProperty("polluted");
    expect(() => appServerArgv("codex", ["features.realtime_conversation=false"])).toThrow(
      "must remain enabled",
    );
    const resolved = resolveConfig(
      { "codex-config": ["approval_policy=never"] },
      { "codex-config": ["approval_policy=on-request"] },
      {},
      "/test",
    );
    expect(resolved.codexConfig).toEqual(["approval_policy=on-request", "approval_policy=never"]);
  });

  for (const mode of ["fresh", "continue", "resume"] as const) {
    test(`${mode}: startup values stay out of thread/realtime payloads and survive redial/Fresh`, async () => {
      const entries = [
        "model=startup-model",
        'experimental_realtime_ws_backend_prompt="explicit startup"',
      ];
      const h = runtimeHarness(
        {
          "codex-config": entries,
          orchestrator: { model: "thread-model", config: { model_reasoning_effort: "high" } },
          voice: { extra: { prompt: "request prompt" } },
        },
        mode === "resume"
          ? { resume: "existing" }
          : mode === "continue"
            ? { continue: true }
            : { fresh: true },
      );
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        await h.runtime.offer("first");
        await h.runtime.offer("redial");
        await h.runtime.fresh();
        await h.runtime.offer("fresh");
        expect(h.native.options.argv).toEqual(appServerArgv("codex", entries));
        expect(h.native.options.cwd).toBe(h.directory);
        expect(h.native.options.env?.["CODEX_HOME"]).toBe(process.env["CODEX_HOME"]);
        const threads = h.native.calls.filter((c) =>
          ["thread/start", "thread/resume"].includes(c.method),
        );
        expect(threads).toHaveLength(2);
        for (const call of threads)
          expect(call.params).toMatchObject({
            cwd: h.directory,
            model: "thread-model",
            config: { model_reasoning_effort: "high" },
          });
        for (const call of h.native.calls) {
          expect(call.params).not.toHaveProperty("codexConfig");
          expect(call.params).not.toHaveProperty("codex-config");
          expect(JSON.stringify(call.params)).not.toContain("explicit startup");
        }
        expect(h.native.calls.some((c) => c.method === "config/read")).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("startup passthrough accepts native restricted effective permissions", async () => {
    const h = runtimeHarness({ "codex-config": ["model=chosen"] });
    h.native.override = (method) =>
      method === "thread/start"
        ? Promise.resolve({
            thread: { id: "bad", cwd: h.directory },
            ...nativeFullAccess,
            sandbox: { type: "readOnly" },
          })
        : undefined;
    try {
      await h.runtime.start();
      expect(h.ready).toHaveLength(1);
      expect(h.native.alive).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test("invalid startup overrides fail before child startup even if config was supplied directly", async () => {
    for (const entry of ["missing-equals", "features.realtime_conversation=false"]) {
      const h = runtimeHarness();
      h.config.codexConfig = [entry];
      try {
        await expect(h.runtime.start()).rejects.toThrow();
        expect(h.native.options).toBeUndefined();
        expect(h.native.calls).toEqual([]);
      } finally {
        await h.cleanup();
      }
    }
  });

  test("Fast sees the child's native startup config while keeping resumed model selection native", async () => {
    for (const fresh of [true, false]) {
      const h = runtimeHarness(
        { "codex-config": ["model=startup-model", "service_tier=default"] },
        { fresh, continue: !fresh, fast: true },
      );
      h.native.tiers = true;
      h.native.nativeConfig = { model: "startup-model", model_provider: "openai" };
      h.native.models = [
        { model: "startup-model", serviceTiers: [{ id: "priority", name: "Fast" }] },
        { model: "saved-model", serviceTiers: [{ id: "priority", name: "Fast" }] },
      ];
      h.native.main("existing", h.directory);
      Object.assign(h.native.threads[0]!, { model: "saved-model" });
      h.native.models = h.native.models.filter(
        (entry) => entry["model"] === (fresh ? "startup-model" : "saved-model"),
      );
      h.native.override = (method) =>
        method === "thread/resume"
          ? Promise.resolve({
              thread: h.native.threads[0],
              ...nativeFullAccess,
              model: "saved-model",
              modelProvider: "openai",
              serviceTier: "priority",
            })
          : undefined;
      try {
        await h.runtime.start();
        expect(h.native.calls.find((c) => c.method === "config/read")?.params).toMatchObject({
          cwd: h.directory,
        });
        const params = h.native.calls.find(
          (c) => c.method === (fresh ? "thread/start" : "thread/resume"),
        )!.params;
        expect(params["serviceTier"]).toBe("priority");
        expect(params["config"]).toEqual({ "features.fast_mode": true });
        expect(params).not.toHaveProperty("model");
      } finally {
        await h.cleanup();
      }
    }
  });

  test("owned subprocess receives literal argv, never evaluated shell content", async () => {
    const entry = 'unknown="$(false); `false` --listen ws://example.invalid = 🎤"';
    const argv = appServerArgv("unused", [entry]);
    const c = await AppServerConnection.connect({
      argv: [process.execPath, join(import.meta.dir, "fixtures/fake-codex.ts"), ...argv.slice(1)],
      cwd: process.cwd(),
      clientVersion: "test",
      onNotification() {},
      onClose() {},
    });
    try {
      const received = await c.request<string[]>("test/argv", {});
      expect(received.slice(0, -4)).toEqual(argv.slice(1));
      expect(received.slice(-4, -1)).toEqual(["--ws-auth", "capability-token", "--ws-token-file"]);
    } finally {
      await c.close();
    }
  });
});
