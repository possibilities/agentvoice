import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ConfigValues, resolveConfig } from "../src/core/config.ts";
import { confirmFullAccess } from "../src/core/full-access.ts";
import { threadParams } from "../src/core/params.ts";
import { parseArgs, parseConsoleCommand } from "../src/main.ts";
import { nativeFullAccess, runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("mandatory full access", () => {
  test("launch requires the exact valueless opt-in; help is exempt", () => {
    expect(() => parseConsoleCommand([])).toThrow("requires --allow-full-access");
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

  test("bare and console refuse before config, child or media startup; no environment bypass", async () => {
    for (const prefix of [[], ["console"]]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../src/main.ts"),
          ...prefix,
          "--config",
          "/definitely-missing-agentvoice-config",
          "--codex",
          "/definitely-missing-codex",
        ],
        {
          env: { ...process.env, AGENTVOICE_ALLOW_FULL_ACCESS: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(err).toContain("requires --allow-full-access");
      expect(err).not.toContain("could not start");
      expect(out).toBe("");
    }
  });

  test("rejects incompatible typed and raw native permission selectors", () => {
    const cases: ConfigValues[] = [
      { orchestrator: { sandbox: "read-only" } },
      { orchestrator: { sandbox: "workspace-write" } },
      { orchestrator: { "approval-policy": "on-request" } },
      { orchestrator: { "approval-policy": "untrusted" } },
      { orchestrator: { permissions: "custom" } },
    ];
    for (const extra of [
      { sandbox: null },
      { sandbox: "read-only" },
      { approvalPolicy: null },
      { approvalPolicy: { granular: {} } },
      { permissions: "custom" },
    ])
      cases.push({ orchestrator: { extra } });
    for (const config of [
      { sandbox_mode: "read-only" },
      { approval_policy: "on-request" },
      { default_permissions: "custom" },
      { "profiles.voice.sandbox_mode": "workspace-write" },
      { profiles: { voice: { approval_policy: "untrusted" } } },
      { "profiles.voice": { default_permissions: "custom" } },
      { "approval_policy.granular.request_permissions": false },
      { "profiles.voice.approval_policy.granular.mcp": false },
    ]) {
      cases.push({ orchestrator: { config } }, { orchestrator: { extra: { config } } });
    }
    for (const values of cases)
      expect(() => resolveConfig({}, values, {}, "/test")).toThrow("full-access-only");
    // CLI does not provide consent to config and a matching permission setting is not consent.
    expect(() =>
      parseConsoleCommand(["--sandbox", "danger-full-access", "--approval-policy", "never"]),
    ).toThrow("--allow-full-access");
  });

  test("matching legacy settings and unrelated passthrough still work for start/resume", () => {
    const config = resolveConfig(
      {},
      {
        orchestrator: {
          sandbox: "danger-full-access",
          "approval-policy": "never",
          config: {
            sandbox_mode: "danger-full-access",
            approval_policy: "never",
            features: { custom: true },
          },
          extra: { newField: true },
        },
      },
      {},
      "/test",
    );
    for (const params of [threadParams(config, {}, "start"), threadParams(config, {}, "resume")])
      expect(params).toMatchObject({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        config: config.orchestrator.config,
      });
  });

  test("requires reported policy, not an echo, unknown state or restricted profile", () => {
    confirmFullAccess(nativeFullAccess);
    confirmFullAccess({ sandbox: nativeFullAccess.sandbox, approvalPolicy: "never" });
    for (const response of [
      undefined,
      {},
      { sandbox: "danger-full-access", approvalPolicy: "never" },
      { ...nativeFullAccess, approvalPolicy: "on-request" },
      { ...nativeFullAccess, sandbox: { type: "externalSandbox", networkAccess: "enabled" } },
      { ...nativeFullAccess, activePermissionProfile: { id: "custom" } },
    ])
      expect(() => confirmFullAccess(response)).toThrow("did not confirm");
  });

  test("a matching raw profile never sends both native permission selectors", () => {
    const config = resolveConfig(
      {},
      { orchestrator: { extra: { permissions: ":danger-full-access" } } },
      {},
      "/test",
    );
    const params = threadParams(config, {}, "start");
    expect(params["permissions"]).toBe(":danger-full-access");
    expect(params).not.toHaveProperty("sandbox");
  });

  test("start and resume fail closed without readiness/voice/turns; native requirements errors stay errors", async () => {
    for (const resume of [false, true])
      for (const managedError of [false, true]) {
        const h = runtimeHarness({}, resume ? { resume: "persisted" } : {});
        if (resume) h.native.main("persisted", h.directory);
        h.native.override = (method) =>
          method === (resume ? "thread/resume" : "thread/start")
            ? managedError
              ? Promise.reject(new Error("managed requirements forbid full access"))
              : Promise.resolve({
                  thread: { id: resume ? "persisted" : "bad" },
                  approvalPolicy: "never",
                  sandbox: { type: "readOnly" },
                })
            : undefined;
        try {
          await expect(h.runtime.start()).rejects.toThrow(
            managedError ? "managed requirements" : "did not confirm",
          );
          expect(h.ready).toEqual([]);
          expect(h.native.closes).toBe(1);
          expect(
            h.native.calls.some((c) => ["thread/realtime/start", "turn/start"].includes(c.method)),
          ).toBe(false);
        } finally {
          await h.cleanup();
        }
      }
  });

  test("Fresh cannot adopt an unverified thread or redial it", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      h.native.override = (m) =>
        m === "thread/start" ? Promise.resolve({ thread: { id: "bad" } }) : undefined;
      await h.runtime.fresh();
      expect(h.fatal.join()).toContain("did not confirm");
      expect(h.runtime.currentReady).toBeNull();
      expect(h.native.closes).toBe(1);
      expect(h.ready).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("a native settings downgrade stops the child without repairing or bypassing policy", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      h.native.options.onNotification("thread/settings/updated", {
        threadId: h.runtime.currentReady!.threadId,
        threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
      });
      await h.runtime.shutdown();
      expect(h.fatal.join()).toContain("did not confirm");
      expect(h.native.closes).toBe(1);
      expect(h.native.calls.some((c) => c.method === "thread/settings/update")).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});
