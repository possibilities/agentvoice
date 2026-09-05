import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonConfig, resolveConfig } from "../src/core/config.ts";
import { realtimeParams, threadParams, workerThreadParams } from "../src/core/params.ts";
import { configLoader, parseArgs, parseConsoleCommand } from "../src/main.ts";

describe("workspace launch", () => {
  test("defaults to launch cwd; CLI wins over file; relative paths and extra roots share that root", () => {
    const file = {
      orchestrator: { workspace: "project", "runtime-workspace-roots": ["assets", "/shared"] },
    };
    const options = { launchCwd: "/launch" };
    expect(resolveConfig({}, {}, {}, "/home/test", options).orchestrator.workspace).toBe("/launch");
    expect(resolveConfig({}, file, {}, "/home/test", options).orchestrator.workspace).toBe(
      "/launch/project",
    );
    const config = resolveConfig(
      { orchestrator: { workspace: "~/code" } },
      file,
      {},
      "/home/test",
      options,
    );
    expect(config.orchestrator.workspace).toBe("/home/test/code");
    expect(config.orchestrator.runtimeWorkspaceRoots).toEqual([
      "/home/test/code/assets",
      "/shared",
    ]);
    expect(threadParams(config, {}, "start")["cwd"]).toBe("/home/test/code");
    expect(workerThreadParams(config)["cwd"]).toBe("/home/test/code");
  });
  test("canonicalizes symlink launches once and rejects nonexistent/file workspaces", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-workspace-")));
    try {
      mkdirSync(join(root, "project"));
      symlinkSync(join(root, "project"), join(root, "alias"));
      writeFileSync(join(root, "settings.json"), "{}");
      const loader = configLoader(
        parseArgs(["--workspace", "alias", "--config", "settings.json"]),
        root,
      );
      expect((await loader.loadResolvedConfig()).orchestrator.workspace).toBe(
        join(root, "project"),
      );
      expect(loader.configPath).toBe(join(root, "settings.json"));
      for (const workspace of ["missing", "settings.json", ""]) {
        await expect(
          configLoader(
            parseArgs(["--workspace", workspace, "--config", "settings.json"]),
            root,
          ).loadResolvedConfig(),
        ).rejects.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects conflicting cwd and conversation identity escape hatches", () => {
    const base = { workspace: "/work" };
    for (const extra of [
      { cwd: "/else" },
      { cwd: null },
      { threadId: "id" },
      { path: "/rollout" },
      { history: [] },
    ]) {
      expect(() => resolveConfig({}, { orchestrator: { ...base, extra } }, {}, "/home")).toThrow();
    }
    for (const extra of [{ threadId: "id" }, { realtimeSessionId: "rt" }]) {
      expect(() => resolveConfig({}, { voice: { extra } }, {}, "/home")).toThrow();
    }
    const config = resolveConfig(
      {},
      { orchestrator: { ...base, extra: { cwd: "/work", threadSource: "not-ours" } } },
      {},
      "/home",
    );
    expect(threadParams(config, {}, "start")["threadSource"]).toBe("agentvoice-orchestrator");
    expect(realtimeParams(config, {}, "t", "rt", "sdp")["threadId"]).toBe("t");
  });
  test("preserves the console/fresh alias, explicit resume, and clear retirement errors", () => {
    for (const flag of ["--fresh", "--no-continue"]) {
      expect(parseConsoleCommand(["--allow-full-access", flag])).toMatchObject({
        help: false,
        options: { fresh: true },
      });
      expect(() => parseConsoleCommand([flag, "--resume", "id"])).toThrow("cannot be combined");
    }
    expect(
      parseConsoleCommand(["--allow-full-access", "--resume=id", "--workspace=/work"]),
    ).toMatchObject({
      options: { resume: "id", fresh: false },
    });
    expect(() => parseArgs(["--resume="])).toThrow("non-empty");
    expect(() => parseJsonConfig('{"remote":{}}', "test")).toThrow("retired");
  });
});
