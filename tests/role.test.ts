import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  type ConfigValues,
  PROMPT_FILES,
  parseJsonConfig,
  readPrompts,
  resolveConfig,
} from "../src/core/config.ts";
import { threadParams } from "../src/core/params.ts";
import {
  ROLE_PROMPT_FILES,
  readRoleAssets,
  resolveRolePath,
  translateMcpServers,
} from "../src/core/role.ts";
import { parseArgs } from "../src/main.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const HOME = "/home/tester";

/** A role directory beside the harness's config directory, addressed by relative path. */
function roleHarness(
  files: Record<string, string>,
  values: ConfigValues = {},
  options: Parameters<typeof runtimeHarness>[1] = {},
) {
  const h = runtimeHarness({ ...values, role: "./role" }, options);
  const dir = join(h.directory, "role");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { ...h, dir };
}

describe("role resolution", () => {
  test("names resolve under the roles home; paths resolve from the launch directory", () => {
    expect(resolveRolePath("researcher", {}, HOME, "/launch")).toBe(
      `${HOME}/.config/agentroles/researcher`,
    );
    expect(resolveRolePath("researcher", { AGENTROLES_HOME: "~/roles" }, HOME, "/launch")).toBe(
      `${HOME}/roles/researcher`,
    );
    expect(resolveRolePath("./role", {}, HOME, "/launch")).toBe("/launch/role");
    expect(resolveRolePath("roles/x", {}, HOME, "/launch")).toBe("/launch/roles/x");
    expect(resolveRolePath("/abs/role", {}, HOME, "/launch")).toBe("/abs/role");
    expect(resolveRolePath("~/mine", {}, HOME, "/launch")).toBe(`${HOME}/mine`);
    for (const bad of ["", "  ", "bad.name", "spaced name", "-leading"])
      expect(() => resolveRolePath(bad, {}, HOME, "/launch")).toThrow(ConfigError);
  });

  test("--role beats the file key; both are plain strings", () => {
    const config = resolveConfig({ role: "cli" }, { role: "file" }, {}, HOME, {
      launchCwd: "/launch",
    });
    expect(config.role).toBe(`${HOME}/.config/agentroles/cli`);
    expect(resolveConfig({}, {}, {}, HOME)).not.toHaveProperty("role");
    expect(parseArgs(["--role", "researcher"]).values["role"]).toBe("researcher");
    expect(parseJsonConfig('{"role":"researcher"}', "settings")).toEqual({ role: "researcher" });
    expect(() => parseJsonConfig('{"role":7}', "settings")).toThrow('"role" must be a string');
  });
});

describe("mcp.json translation", () => {
  test("keeps Codex-native keys, translates Claude-only ones, rejects the unsupported", () => {
    const servers = translateMcpServers(
      {
        mcpServers: {
          papers: { type: "stdio", command: "uvx", args: ["papers-mcp"], env: { A: "1" } },
          docs: { type: "http", url: "https://example.test/mcp", headers: { "X-Key": "k" } },
          plain: { command: "srv", startup_timeout_sec: 5 },
        },
      },
      "mcp.json",
    );
    expect(servers).toEqual({
      papers: { command: "uvx", args: ["papers-mcp"], env: { A: "1" } },
      docs: { url: "https://example.test/mcp", http_headers: { "X-Key": "k" } },
      plain: { command: "srv", startup_timeout_sec: 5 },
    });
    const bad: unknown[] = [
      null,
      {},
      { mcpServers: [] },
      { mcpServers: { "bad.name": { command: "x" } } },
      { mcpServers: { x: "string" } },
      { mcpServers: { x: { type: "sse", url: "u" } } },
      { mcpServers: { x: { command: "c", url: "u" } } },
      { mcpServers: { x: { args: [] } } },
      { mcpServers: { x: { url: "u", headers: "nope" } } },
    ];
    for (const document of bad)
      expect(() => translateMcpServers(document, "mcp.json")).toThrow(ConfigError);
  });

  test("readRoleAssets reports the directory, servers and skills root; missing roles fail", async () => {
    const h = roleHarness({
      "mcp.json": JSON.stringify({ mcpServers: { srv: { command: "srv" } } }),
      "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\n",
    });
    try {
      expect(await readRoleAssets(h.dir)).toEqual({
        dir: h.dir,
        mcpServers: { srv: { command: "srv" } },
        skillsRoot: join(h.dir, "skills"),
      });
      mkdirSync(join(h.directory, "bare"));
      expect(await readRoleAssets(join(h.directory, "bare"))).toEqual({
        dir: join(h.directory, "bare"),
      });
      await expect(readRoleAssets(join(h.directory, "missing"))).rejects.toThrow(
        "role directory not found",
      );
      await expect(readRoleAssets("relative")).rejects.toThrow("must be absolute");
      writeFileSync(join(h.dir, "mcp.json"), "{");
      await expect(readRoleAssets(h.dir)).rejects.toThrow("not valid JSON");
    } finally {
      await h.cleanup();
    }
  });
});

describe("role prompt files", () => {
  test("general files prime the orchestrator; voice variants stand in for the same kind", async () => {
    const h = roleHarness({
      [ROLE_PROMPT_FILES.orchestratorBaseInstructions]: "general base",
      [PROMPT_FILES.voicePrompt]: "voice",
      [PROMPT_FILES.orchestratorSessionStart]: "start",
    });
    try {
      let loaded = await readPrompts(h.config);
      expect(loaded.prompts).toEqual({
        orchestratorBaseInstructions: "general base",
        voicePrompt: "voice",
        orchestratorSessionStart: "start",
      });
      expect(loaded.paths).toEqual([
        join(h.dir, PROMPT_FILES.voicePrompt),
        join(h.dir, ROLE_PROMPT_FILES.orchestratorBaseInstructions),
        join(h.dir, PROMPT_FILES.orchestratorSessionStart),
      ]);
      writeFileSync(join(h.dir, PROMPT_FILES.orchestratorBaseInstructions), "voice base");
      loaded = await readPrompts(h.config);
      expect(loaded.prompts.orchestratorBaseInstructions).toBe("voice base");
      expect(loaded.paths).toContain(join(h.dir, PROMPT_FILES.orchestratorBaseInstructions));
      expect(loaded.paths).not.toContain(
        join(h.dir, ROLE_PROMPT_FILES.orchestratorBaseInstructions),
      );
    } finally {
      await h.cleanup();
    }
  });

  const conflicts: Array<[string, string]> = [
    [
      ROLE_PROMPT_FILES.orchestratorBaseInstructions,
      PROMPT_FILES.orchestratorDeveloperInstructions,
    ],
    [
      ROLE_PROMPT_FILES.orchestratorDeveloperInstructions,
      PROMPT_FILES.orchestratorBaseInstructions,
    ],
    [
      ROLE_PROMPT_FILES.orchestratorBaseInstructions,
      ROLE_PROMPT_FILES.orchestratorDeveloperInstructions,
    ],
  ];
  for (const [first, second] of conflicts) {
    test(`${first} with ${second} is a replace/append conflict`, async () => {
      const h = roleHarness({ [first]: "a", [second]: "b" });
      try {
        await expect(readPrompts(h.config)).rejects.toThrow("cannot both be present");
        await expect(h.runtime.start()).rejects.toThrow("cannot both be present");
        expect(h.native.options).toBeUndefined();
      } finally {
        await h.cleanup();
      }
    });
  }

  test("an active role shadows config-directory prompt files with a warning", async () => {
    const h = roleHarness({ [ROLE_PROMPT_FILES.orchestratorDeveloperInstructions]: "role append" });
    writeFileSync(join(h.directory, PROMPT_FILES.voicePrompt), "config dir prompt");
    writeFileSync(join(h.directory, "VOICE.md"), "legacy");
    const warnings: string[] = [];
    try {
      const loaded = await readPrompts(h.config, (line) => warnings.push(line));
      expect(loaded.prompts).toEqual({ orchestratorDeveloperInstructions: "role append" });
      expect(warnings.some((line) => line.includes(PROMPT_FILES.voicePrompt))).toBe(true);
      expect(warnings.some((line) => line.includes("legacy prompt file"))).toBe(true);
      expect(warnings.join()).not.toContain("config dir prompt");
    } finally {
      await h.cleanup();
    }
  });
});

describe("role MCP servers in thread config", () => {
  const configure = (values: ConfigValues = {}) => resolveConfig({}, values, {}, HOME);
  const role = { mcpServers: { srv: { command: "srv", args: ["--x"] } } };

  test("merge into per-thread config on start and resume beside named entries", () => {
    for (const kind of ["start", "resume"] as const) {
      const params = threadParams(
        configure({
          orchestrator: { effort: "low", config: { mcp_servers: { other: { url: "u" } } } },
        }),
        {},
        kind,
        role,
      );
      expect(params["config"]).toEqual({
        model_reasoning_effort: "low",
        mcp_servers: { other: { url: "u" }, srv: { command: "srv", args: ["--x"] } },
      });
    }
    expect(threadParams(configure(), {}, "start", {})).not.toHaveProperty("config");
  });

  test("name collisions and raw replacements are errors, not silent merges", () => {
    expect(() =>
      threadParams(
        configure({ orchestrator: { config: { mcp_servers: { srv: {} } } } }),
        {},
        "start",
        role,
      ),
    ).toThrow('both define "srv"');
    expect(() =>
      threadParams(configure({ orchestrator: { config: { mcp_servers: 3 } } }), {}, "start", role),
    ).toThrow("must be an object");
    expect(() =>
      threadParams(
        configure({ orchestrator: { extra: { config: { model: "m" } } } }),
        {},
        "start",
        role,
      ),
    ).toThrow('replaced the role\'s MCP server "srv"');
  });
});

describe("role launch", () => {
  test("skills register on the owned child before any thread work; MCPs and prompts ride the thread", async () => {
    const h = roleHarness({
      "mcp.json": JSON.stringify({ mcpServers: { srv: { command: "srv" } } }),
      "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\n",
      [ROLE_PROMPT_FILES.orchestratorDeveloperInstructions]: "role append",
    });
    const warnings: string[] = [];
    h.events.onStatus = (line) => warnings.push(line);
    try {
      await h.runtime.start();
      const methods = h.native.calls.map((call) => call.method);
      expect(methods[0]).toBe("skills/extraRoots/set");
      expect(h.native.calls[0]!.params).toEqual({ extraRoots: [join(h.dir, "skills")] });
      expect(methods.indexOf("thread/list")).toBeGreaterThan(0);
      const start = h.native.calls.find((call) => call.method === "thread/start")!;
      expect(start.params["developerInstructions"]).toBe("role append");
      expect(start.params["config"]).toEqual({ mcp_servers: { srv: { command: "srv" } } });
      expect(h.runtime.currentReady!.prompts).toEqual([
        join(h.dir, ROLE_PROMPT_FILES.orchestratorDeveloperInstructions),
      ]);
      expect(warnings).toContain(`role: ${h.dir}`);
      await h.runtime.fresh();
      expect(h.native.calls.filter((call) => call.method === "skills/extraRoots/set")).toHaveLength(
        1,
      );
    } finally {
      await h.cleanup();
    }
  });

  test("a role without skills registers nothing; a missing role fails before native startup", async () => {
    const bare = roleHarness({});
    try {
      await bare.runtime.start();
      expect(bare.native.calls.map((call) => call.method)).not.toContain("skills/extraRoots/set");
    } finally {
      await bare.cleanup();
    }
    const missing = runtimeHarness({ role: "./absent" });
    try {
      await expect(missing.runtime.start()).rejects.toThrow("role directory not found");
      expect(missing.native.options).toBeUndefined();
      expect(missing.ready).toEqual([]);
    } finally {
      await missing.cleanup();
    }
  });

  test("a child that cannot register skill roots stops the launch and closes", async () => {
    const h = roleHarness({ "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\n" });
    h.native.override = (method) =>
      method === "skills/extraRoots/set"
        ? Promise.reject(new Error("Method not found"))
        : undefined;
    try {
      await expect(h.runtime.start()).rejects.toThrow("skills/extraRoots/set");
      expect(h.native.calls.map((call) => call.method)).toEqual(["skills/extraRoots/set"]);
      expect(h.native.closes).toBe(1);
      expect(h.ready).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
