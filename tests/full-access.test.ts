import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigValues, resolveConfig } from "../src/core/config.ts";
import { fullAccessStartupConfig } from "../src/core/full-access.ts";
import { threadParams } from "../src/core/params.ts";
import { loadLaunchConfig, parseArgs, parseConsoleCommand } from "../src/main.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("optional full access", () => {
  test("launch accepts omission and the exact valueless opt-in", () => {
    expect(parseConsoleCommand([])).toMatchObject({ help: false });
    expect(parseArgs([])).not.toHaveProperty("allowFullAccess");
    expect(parseConsoleCommand(["--allow-full-access"])).toMatchObject({
      parsed: { allowFullAccess: true },
    });
    expect(parseConsoleCommand(["--help"])).toEqual({ help: true });
    for (const flag of [
      "--allow-full-access=true",
      "--allow-full-access=false",
      "--no-allow-full-access",
    ])
      expect(() => parseConsoleCommand([flag])).toThrow();
    expect(parseArgs(["--allow-full-access"]).values).toEqual({});
  });

  test("unset permission fields stay absent on start and resume", () => {
    const config = resolveConfig({}, {}, { AGENTVOICE_ALLOW_FULL_ACCESS: "1" }, "/test");
    expect(config).not.toHaveProperty("allowFullAccess");
    expect(fullAccessStartupConfig(config)).toBeUndefined();
    for (const kind of ["start", "resume"] as const) {
      const params = threadParams(config, {}, kind);
      for (const field of ["sandbox", "approvalPolicy", "permissions", "config"])
        expect(params).not.toHaveProperty(field);
    }
  });

  test("typed and raw restricted settings retain native passthrough semantics", () => {
    const cases: ConfigValues[] = [
      { orchestrator: { sandbox: "read-only", "approval-policy": "on-request" } },
      { orchestrator: { sandbox: "workspace-write", "approval-policy": "untrusted" } },
      { orchestrator: { permissions: "custom" } },
    ];
    for (const extra of [
      { sandbox: null, approvalPolicy: null },
      { sandbox: "read-only", approvalPolicy: { granular: { mcp: false } } },
      { permissions: "custom" },
    ])
      cases.push({ orchestrator: { extra } });
    for (const config of [
      { sandbox_mode: "read-only", approval_policy: "on-request", default_permissions: "custom" },
      { "profiles.voice.sandbox_mode": "workspace-write" },
      { profiles: { voice: { approval_policy: "untrusted" } } },
      { "approval_policy.granular.request_permissions": false },
    ])
      cases.push({ orchestrator: { config } }, { orchestrator: { extra: { config } } });
    for (const values of cases) {
      const config = resolveConfig({}, values, {}, "/test");
      for (const kind of ["start", "resume"] as const) {
        const params = threadParams(config, {}, kind);
        if (values.orchestrator?.extra) expect(params).toMatchObject(values.orchestrator.extra);
        if (values.orchestrator?.config)
          expect(params["config"]).toEqual(values.orchestrator.config);
      }
    }
  });

  test("CLI opt-in wins permission selectors after raw replacement without flattening other config", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-permissions-")));
    const raw = {
      approval_policy: { granular: { mcp: false } },
      "approval_policy.granular.request_permissions": false,
      sandbox_mode: "read-only",
      default_permissions: "restricted",
      profiles: { voice: { sandbox_mode: "workspace-write" } },
      mcp_servers: { example: { command: "example" } },
      "features.other": false,
    };
    const file = {
      "codex-config": ['approval_policy="untrusted"', "default_permissions=restricted"],
      orchestrator: {
        permissions: "restricted",
        sandbox: "workspace-write",
        "approval-policy": "on-request",
        config: { overwrittenByRaw: true },
        extra: {
          sandbox: "read-only",
          permissions: "custom",
          approvalPolicy: "on-request",
          config: raw,
          other: 7,
        },
      },
    };
    try {
      writeFileSync(join(directory, "settings.json"), JSON.stringify(file));
      const config = await loadLaunchConfig(
        parseArgs([
          "--config",
          "settings.json",
          "--allow-full-access",
          "-c",
          "sandbox_mode=workspace-write",
        ]),
        directory,
      );
      expect(config.allowFullAccess).toBe(true);
      expect(config.codexConfig).toEqual([...file["codex-config"], "sandbox_mode=workspace-write"]);
      expect(fullAccessStartupConfig(config)).toEqual([
        ...config.codexConfig!,
        'sandbox_mode="danger-full-access"',
        'approval_policy="never"',
        'default_permissions=":danger-full-access"',
      ]);
      for (const kind of ["start", "resume"] as const) {
        const params = threadParams(
          config,
          { orchestratorDeveloperInstructions: "", voiceAppend: undefined },
          kind,
        );
        expect(params).toMatchObject({
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          other: 7,
          developerInstructions: "",
        });
        expect(params).not.toHaveProperty("permissions");
        expect(params["config"]).toEqual({
          profiles: raw.profiles,
          mcp_servers: raw.mcp_servers,
          "features.other": false,
          sandbox_mode: "danger-full-access",
          approval_policy: "never",
          default_permissions: ":danger-full-access",
        });
      }
      expect(config.orchestrator.extra?.["config"]).toEqual(raw);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const resume of [false, true]) {
    test(`${resume ? "resume" : "start"} accepts native restricted and unknown state`, async () => {
      for (const reported of [
        {},
        {
          approvalPolicy: "on-request",
          sandbox: { type: "readOnly" },
          activePermissionProfile: { id: "custom" },
        },
      ]) {
        const h = runtimeHarness({}, resume ? { resume: "persisted" } : { fresh: true });
        h.native.main("persisted", h.directory);
        h.native.override = (method) =>
          method === (resume ? "thread/resume" : "thread/start")
            ? Promise.resolve({ thread: { id: resume ? "persisted" : "restricted" }, ...reported })
            : undefined;
        try {
          await h.runtime.start();
          expect(h.runtime.currentReady?.threadId).toBe(resume ? "persisted" : "restricted");
          expect(h.native.alive).toBe(true);
          expect(h.fatal).toEqual([]);
        } finally {
          await h.cleanup();
        }
      }
    });

    test(`${resume ? "resume" : "start"} preserves managed requirement refusals with opt-in`, async () => {
      const h = runtimeHarness({}, resume ? { resume: "persisted" } : { fresh: true });
      h.config.allowFullAccess = true;
      h.native.main("persisted", h.directory);
      h.native.override = (method) =>
        method === (resume ? "thread/resume" : "thread/start")
          ? Promise.reject(new Error("managed requirements forbid full access"))
          : undefined;
      try {
        await expect(h.runtime.start()).rejects.toThrow("managed requirements");
        expect(h.ready).toEqual([]);
        expect(h.native.closes).toBe(1);
        expect(
          h.native.calls.some((c) =>
            ["thread/realtime/start", "turn/start", "thread/settings/update"].includes(c.method),
          ),
        ).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("Fresh and later native restricted settings keep the runtime available without policy repair", async () => {
    const h = runtimeHarness();
    h.config.allowFullAccess = true;
    try {
      await h.runtime.start();
      h.native.override = (method) =>
        method === "thread/start"
          ? Promise.resolve({ thread: { id: "restricted" }, sandbox: { type: "readOnly" } })
          : undefined;
      await h.runtime.fresh();
      h.native.options.onNotification("thread/settings/updated", {
        threadId: "restricted",
        threadSettings: {
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
          model: "native-new-model",
        },
      });
      expect(h.runtime.currentReady?.threadId).toBe("restricted");
      expect(h.runtime.currentReady?.model).toBe("native-new-model");
      expect(h.fatal).toEqual([]);
      expect(h.native.alive).toBe(true);
      expect(h.native.calls.some((c) => c.method === "thread/settings/update")).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});
