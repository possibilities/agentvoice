import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseClientArgs, UsageError } from "../src/main.ts";
import {
  ConfigError,
  cliToConfigValues,
  loadConfigFile,
  parseJsonConfig,
  promptFilenames,
  readPrompts,
  resolveConfig,
} from "../src/server/config.ts";

const HOME = "/home/tester";

describe("resolveConfig", () => {
  test("applies defaults when nothing is set", () => {
    const config = resolveConfig({}, {}, {}, HOME);
    expect(config.port).toBe(7890);
    expect(config.codex).toBe("codex");
    expect(config.orchestrator.sandbox).toBe("danger-full-access");
    expect(config.orchestrator.approvalPolicy).toBe("never");
    expect(config.orchestrator.workspace).toBe("/home/tester/.local/state/agentvoice/workspace");
    expect(config.orchestrator.model).toBeUndefined();
    expect(config.orchestrator.effort).toBeUndefined();
    expect(config.orchestrator.personality).toBeUndefined();
    expect(config.voice.version).toBe("v3");
    expect(config.voice.model).toBeUndefined();
    expect(config.voice.includeStartupContext).toBeUndefined();
  });

  test("CLI beats file beats default, per leaf", () => {
    const config = resolveConfig(
      { orchestrator: { model: "cli-model" }, port: "9000" },
      {
        orchestrator: { model: "file-model", effort: "high", personality: "pragmatic" },
        voice: { name: "marin" },
        port: 9999,
      },
      {},
      HOME,
    );
    expect(config.orchestrator.model).toBe("cli-model");
    expect(config.orchestrator.effort).toBe("high");
    expect(config.orchestrator.personality).toBe("pragmatic");
    expect(config.voice.name).toBe("marin");
    expect(config.port).toBe(9000);
  });

  test("keeps false apart from unset", () => {
    const config = resolveConfig(
      {},
      { voice: { "include-startup-context": false, "delegation-ack-filler": true } },
      {},
      HOME,
    );
    expect(config.voice.includeStartupContext).toBe(false);
    expect(config.voice.delegationAckFiller).toBe(true);
    expect(config.voice.clientManagedHandoffs).toBeUndefined();
  });

  test("honors CODEX_PATH and XDG_STATE_HOME", () => {
    const config = resolveConfig(
      {},
      {},
      { CODEX_PATH: "/opt/codex", XDG_STATE_HOME: "/var/state" },
      HOME,
    );
    expect(config.codex).toBe("/opt/codex");
    expect(config.orchestrator.workspace).toBe("/var/state/agentvoice/workspace");
  });

  test("expands tilde in workspace, roots, and codex paths", () => {
    const config = resolveConfig(
      {
        codex: "~/bin/codex",
        orchestrator: { workspace: "~/w", "runtime-workspace-roots": ["~/a", "/b"] },
      },
      {},
      {},
      HOME,
    );
    expect(config.orchestrator.workspace).toBe("/home/tester/w");
    expect(config.orchestrator.runtimeWorkspaceRoots).toEqual(["/home/tester/a", "/b"]);
    expect(config.codex).toBe("/home/tester/bin/codex");
  });

  test("rejects an invalid port", () => {
    expect(() => resolveConfig({ port: "0" }, {}, {}, HOME)).toThrow(ConfigError);
    expect(() => resolveConfig({ port: "nope" }, {}, {}, HOME)).toThrow(ConfigError);
  });

  test("rejects permissions combined with sandbox", () => {
    expect(() =>
      resolveConfig({}, { orchestrator: { permissions: "p", sandbox: "read-only" } }, {}, HOME),
    ).toThrow(/cannot be combined/);
    const config = resolveConfig({}, { orchestrator: { permissions: "p" } }, {}, HOME);
    expect(config.orchestrator.permissions).toBe("p");
  });

  test("dispatch-reports requires dispatch", () => {
    expect(() =>
      resolveConfig({}, { orchestrator: { "dispatch-reports": true } }, {}, HOME),
    ).toThrow(/requires orchestrator.dispatch/);
    const config = resolveConfig(
      {},
      { orchestrator: { dispatch: true, "dispatch-reports": true } },
      {},
      HOME,
    );
    expect(config.orchestrator.dispatch).toBe(true);
    expect(config.orchestrator.dispatchReports).toBe(true);
    expect(
      resolveConfig({}, { orchestrator: { dispatch: true } }, {}, HOME).orchestrator,
    ).toHaveProperty("dispatchReports", undefined);
  });

  test("configDir defaults to the config directory", () => {
    expect(resolveConfig({}, {}, {}, HOME).configDir).toBe("/home/tester/.config/agentvoice");
    expect(resolveConfig({}, {}, {}, HOME, { configDir: "/etc/avn" }).configDir).toBe("/etc/avn");
  });
});

describe("parseJsonConfig", () => {
  test("parses nested sections", () => {
    const values = parseJsonConfig(
      JSON.stringify({
        port: 9001,
        orchestrator: {
          model: "gpt-5.3-codex",
          personality: "friendly",
          ephemeral: false,
          config: { model_reasoning_summary_format: "experimental" },
        },
        voice: {
          model: "gpt-realtime",
          name: "marin",
          "include-startup-context": false,
          "codex-response-handoff-channel-prefixes": { final: ["[RESULT] "] },
        },
      }),
      "server.json",
    );
    expect(values).toEqual({
      port: 9001,
      orchestrator: {
        model: "gpt-5.3-codex",
        personality: "friendly",
        ephemeral: false,
        config: { model_reasoning_summary_format: "experimental" },
      },
      voice: {
        model: "gpt-realtime",
        name: "marin",
        "include-startup-context": false,
        "codex-response-handoff-channel-prefixes": { final: ["[RESULT] "] },
      },
    });
  });

  test("empty and null documents yield no values", () => {
    expect(parseJsonConfig("", "server.json")).toEqual({});
    expect(parseJsonConfig("   \n", "server.json")).toEqual({});
    expect(parseJsonConfig("null", "server.json")).toEqual({});
  });

  test("ignores $schema, which is reserved for editor tooling", () => {
    expect(parseJsonConfig('{ "$schema": "./server.schema.json" }', "server.json")).toEqual({});
  });

  test("rejects a document that is not JSON", () => {
    expect(() => parseJsonConfig("port: 9001\n", "server.json")).toThrow(/not valid JSON/);
  });

  test("names where each moved key went", () => {
    expect(() => parseJsonConfig('{"model": "m"}', "server.json")).toThrow(
      /"model" moved to "orchestrator.model"/,
    );
    expect(() => parseJsonConfig('{"voice-model": "vm"}', "server.json")).toThrow(
      /"voice-model" moved to "voice.model"/,
    );
    expect(() => parseJsonConfig('{"voice": "marin"}', "server.json")).toThrow(
      /moved to "voice.name"/,
    );
    expect(() => parseJsonConfig('{"orchestrator": {"voice-model": "vm"}}', "server.json")).toThrow(
      /did you mean "voice.model"/,
    );
  });

  test("rejects unknown keys, bad enums, and bad types", () => {
    expect(() => parseJsonConfig('{"modle": "typo"}', "server.json")).toThrow(
      /unknown option "modle"/,
    );
    expect(() => parseJsonConfig('{"orchestrator": {"nope": 1}}', "server.json")).toThrow(
      /unknown option "orchestrator.nope"/,
    );
    expect(() =>
      parseJsonConfig('{"orchestrator": {"personality": "zany"}}', "server.json"),
    ).toThrow(/must be one of none, friendly, pragmatic/);
    expect(() => parseJsonConfig('{"voice": {"version": "v9"}}', "server.json")).toThrow(
      /must be one of v1, v2, v3/,
    );
    expect(() =>
      parseJsonConfig('{"voice": {"include-startup-context": "yep"}}', "server.json"),
    ).toThrow(/must be true or false/);
    expect(() => parseJsonConfig('{"orchestrator": {"dispatch": "yep"}}', "server.json")).toThrow(
      /must be true or false/,
    );
    expect(parseJsonConfig('{"orchestrator": {"dispatch": true}}', "server.json")).toEqual({
      orchestrator: { dispatch: true },
    });
    expect(() =>
      parseJsonConfig('{"orchestrator": {"dispatch-reports": "yep"}}', "server.json"),
    ).toThrow(/must be true or false/);
    expect(() => parseJsonConfig('{"orchestrator": 3}', "server.json")).toThrow(
      /must be an object/,
    );
    expect(() => parseJsonConfig('["a", "b"]', "server.json")).toThrow(ConfigError);
  });
});

describe("loadConfigFile", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "avn-config-"));
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test("a missing default-path file is no config at all", async () => {
    expect(await loadConfigFile(join(directory, "absent", "server.json"), false)).toEqual({});
  });

  test("a missing explicit file is an error", async () => {
    await expect(loadConfigFile(join(directory, "absent", "server.json"), true)).rejects.toThrow(
      /config file not found/,
    );
  });

  test("a stray server.yaml beside a missing server.json is ignored", async () => {
    const strayDir = mkdtempSync(join(tmpdir(), "avn-stray-"));
    try {
      writeFileSync(join(strayDir, "server.yaml"), "orchestrator:\n  dispatch: true\n");
      expect(await loadConfigFile(join(strayDir, "server.json"), false)).toEqual({});
    } finally {
      rmSync(strayDir, { recursive: true, force: true });
    }
  });
});

describe("server.json.example", () => {
  test("is a no-op when copied verbatim", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "server.json.example")).text();
    const values = parseJsonConfig(text, "server.json.example");
    expect(values).toEqual({});
    expect(resolveConfig({}, values, {}, HOME)).toEqual(resolveConfig({}, {}, {}, HOME));
  });
});

describe("cliToConfigValues", () => {
  test("maps flat flags onto nested sections", () => {
    expect(
      cliToConfigValues({
        model: "m",
        effort: "high",
        workspace: "/w",
        "voice-model": "vm",
        voice: "marin",
        port: "9000",
        codex: "/bin/codex",
      }),
    ).toEqual({
      port: "9000",
      codex: "/bin/codex",
      orchestrator: { model: "m", effort: "high", workspace: "/w" },
      voice: { model: "vm", name: "marin" },
    });
  });

  test("omits sections nobody set, and validates enums", () => {
    expect(cliToConfigValues({})).toEqual({});
    expect(cliToConfigValues({ sandbox: "read-only" })).toEqual({
      orchestrator: { sandbox: "read-only" },
    });
    expect(() => cliToConfigValues({ sandbox: "yolo" })).toThrow(ConfigError);
    expect(() => cliToConfigValues({ "approval-policy": "always" })).toThrow(ConfigError);
  });
});

describe("prompt files", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "avn-prompts-"));
    writeFileSync(join(directory, "ORCHESTRATOR.md"), "be terse\n");
    writeFileSync(join(directory, "VOICE.md"), ""); // empty strips the built-in prompt
    writeFileSync(join(directory, "VOICE_SEED_DEVELOPER.md"), "seed\n");
    writeFileSync(join(directory, "NOT_A_PROMPT.md"), "ignored\n");
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test("reads conventional names only, keeping empty apart from absent", async () => {
    const prompts = await readPrompts(directory);
    expect(prompts.orchestratorDeveloperInstructions).toBe("be terse\n");
    expect(prompts.voiceSeedDeveloper).toBe("seed\n");
    expect(prompts.voicePrompt).toBe("");
    expect(prompts.orchestratorBaseInstructions).toBeUndefined();
    expect(prompts.voiceSeedUser).toBeUndefined();
  });

  test("reports what it found, in a stable order", async () => {
    expect(promptFilenames(await readPrompts(directory))).toEqual([
      "VOICE.md",
      "VOICE_SEED_DEVELOPER.md",
      "ORCHESTRATOR.md",
    ]);
  });

  test("an empty directory yields nothing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "avn-empty-"));
    try {
      expect(await readPrompts(empty)).toEqual({});
      expect(promptFilenames({})).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("parseArgs", () => {
  test("collects values, --key=value, and booleans", () => {
    const parsed = parseArgs([
      "--model",
      "m1",
      "--voice-model=vm",
      "--config",
      "/tmp/c.json",
      "--debug",
    ]);
    expect(parsed.values).toEqual({ model: "m1", "voice-model": "vm" });
    expect(parsed.configPath).toBe("/tmp/c.json");
    expect(parsed.debug).toBe(true);
    expect(parsed.help).toBe(false);
  });

  test("rejects unknown, repeated, and valueless flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["--model", "a", "--model", "b"])).toThrow(UsageError);
    expect(() => parseArgs(["--model"])).toThrow(UsageError);
    expect(() => parseArgs(["--model", "--port"])).toThrow(UsageError);
    expect(() => parseArgs(["--debug=1"])).toThrow(UsageError);
  });
});

describe("parseClientArgs", () => {
  test("defaults to system devices", () => {
    expect(parseClientArgs([])).toEqual({
      help: false,
      config: {
        url: "ws://127.0.0.1:7890/ws",
        debug: false,
      },
    });
  });

  test("parses both device indices", () => {
    expect(
      parseClientArgs([
        "--url=ws://voice.test/ws",
        "--token",
        "secret",
        "--device",
        "1",
        "--output-device=2",
        "--debug",
      ]),
    ).toEqual({
      help: false,
      config: {
        url: "ws://voice.test/ws",
        token: "secret",
        deviceIndex: 1,
        outputDeviceIndex: 2,
        debug: true,
      },
    });
  });

  test("rejects the removed backend selector", () => {
    expect(() => parseClientArgs(["--audio-backend", "duplex"])).toThrow(UsageError);
  });

  test("rejects malformed and out-of-range device indices", () => {
    for (const value of ["1junk", "1.5", "-1", "+1", "", "2147483648"]) {
      expect(() => parseClientArgs([`--device=${value}`])).toThrow(
        /must be a non-negative 32-bit integer/,
      );
    }
  });

  test("lets --help bypass value validation after syntax is parsed", () => {
    expect(parseClientArgs(["--device=bad", "--help"])).toEqual({ help: true });
  });
});
