import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseClientArgs, UsageError } from "../src/main.ts";
import {
  ConfigError,
  cliToConfigValues,
  parseYamlConfig,
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

describe("parseYamlConfig", () => {
  test("parses nested sections", () => {
    const values = parseYamlConfig(
      [
        "port: 9001",
        "orchestrator:",
        "  model: gpt-5.3-codex",
        "  personality: friendly",
        "  ephemeral: false",
        "  config:",
        "    model_reasoning_summary_format: experimental",
        "voice:",
        "  model: gpt-realtime",
        "  name: marin",
        "  include-startup-context: false",
        "  codex-response-handoff-channel-prefixes:",
        "    final: ['[RESULT] ']",
        "",
      ].join("\n"),
      "server.yaml",
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

  test("empty file yields no values", () => {
    expect(parseYamlConfig("", "server.yaml")).toEqual({});
    expect(parseYamlConfig("# comments only\n", "server.yaml")).toEqual({});
  });

  test("names where each moved key went", () => {
    expect(() => parseYamlConfig("model: m\n", "server.yaml")).toThrow(
      /"model" moved to "orchestrator.model"/,
    );
    expect(() => parseYamlConfig("voice-model: vm\n", "server.yaml")).toThrow(
      /"voice-model" moved to "voice.model"/,
    );
    expect(() => parseYamlConfig("voice: marin\n", "server.yaml")).toThrow(/moved to "voice.name"/);
    expect(() => parseYamlConfig("orchestrator:\n  voice-model: vm\n", "server.yaml")).toThrow(
      /did you mean "voice.model"/,
    );
  });

  test("rejects unknown keys, bad enums, and bad types", () => {
    expect(() => parseYamlConfig("modle: typo\n", "server.yaml")).toThrow(/unknown option "modle"/);
    expect(() => parseYamlConfig("orchestrator:\n  nope: 1\n", "server.yaml")).toThrow(
      /unknown option "orchestrator.nope"/,
    );
    expect(() => parseYamlConfig("orchestrator:\n  personality: zany\n", "server.yaml")).toThrow(
      /must be one of none, friendly, pragmatic/,
    );
    expect(() => parseYamlConfig("voice:\n  version: v9\n", "server.yaml")).toThrow(
      /must be one of v1, v2, v3/,
    );
    expect(() =>
      parseYamlConfig("voice:\n  include-startup-context: yep\n", "server.yaml"),
    ).toThrow(/must be true or false/);
    expect(() => parseYamlConfig("orchestrator:\n  dispatch: yep\n", "server.yaml")).toThrow(
      /must be true or false/,
    );
    expect(parseYamlConfig("orchestrator:\n  dispatch: true\n", "server.yaml")).toEqual({
      orchestrator: { dispatch: true },
    });
    expect(() =>
      parseYamlConfig("orchestrator:\n  dispatch-reports: yep\n", "server.yaml"),
    ).toThrow(/must be true or false/);
    expect(() => parseYamlConfig("orchestrator: 3\n", "server.yaml")).toThrow(/must be a mapping/);
    expect(() => parseYamlConfig("- a\n- b\n", "server.yaml")).toThrow(ConfigError);
  });
});

describe("server.yaml.example", () => {
  test("is a no-op when copied verbatim", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "server.yaml.example")).text();
    const values = parseYamlConfig(text, "server.yaml.example");
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
      "/tmp/c.yaml",
      "--debug",
    ]);
    expect(parsed.values).toEqual({ model: "m1", "voice-model": "vm" });
    expect(parsed.configPath).toBe("/tmp/c.yaml");
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
  test("defaults to the sox backend and system devices", () => {
    expect(parseClientArgs([])).toEqual({
      help: false,
      config: {
        url: "ws://127.0.0.1:7890/ws",
        audioBackend: "sox",
        debug: false,
      },
    });
  });

  test("parses the duplex backend and both device indices", () => {
    expect(
      parseClientArgs([
        "--url=ws://voice.test/ws",
        "--token",
        "secret",
        "--device",
        "1",
        "--output-device=2",
        "--audio-backend",
        "duplex",
        "--debug",
      ]),
    ).toEqual({
      help: false,
      config: {
        url: "ws://voice.test/ws",
        token: "secret",
        deviceIndex: 1,
        outputDeviceIndex: 2,
        audioBackend: "duplex",
        debug: true,
      },
    });
  });

  test("rejects an unknown backend and a duplex-only output option on sox", () => {
    expect(() => parseClientArgs(["--audio-backend", "other"])).toThrow(
      /must be "sox" or "duplex"/,
    );
    expect(() => parseClientArgs(["--output-device", "1"])).toThrow(
      /requires --audio-backend duplex/,
    );
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
