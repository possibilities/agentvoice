import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  cliToConfigValues,
  loadConfigFile,
  parseJsonConfig,
  promptFilenames,
  readPrompts,
  resolveConfig,
} from "../src/core/config.ts";
import { parseArgs, parseConsoleCommand, UsageError } from "../src/main.ts";

const HOME = "/home/tester";

describe("resolveConfig", () => {
  test("applies defaults when nothing is set", () => {
    const config = resolveConfig({}, {}, {}, HOME);
    expect(config.codex).toBe("codex");
    expect(config.orchestrator.sandbox).toBe("danger-full-access");
    expect(config.orchestrator.approvalPolicy).toBe("never");
    expect(config.orchestrator.workspace).toBe("/home/tester");
    expect(config.orchestrator.model).toBeUndefined();
    expect(config.orchestrator.effort).toBeUndefined();
    expect(config.orchestrator.personality).toBeUndefined();
    expect(config.voice.version).toBe("v3");
    expect(config.voice.model).toBeUndefined();
    expect(config.voice.includeStartupContext).toBeUndefined();
  });

  test("CLI beats file beats default, per leaf", () => {
    const config = resolveConfig(
      { orchestrator: { model: "cli-model" }, codex: "/cli/codex" },
      {
        orchestrator: { model: "file-model", effort: "high", personality: "pragmatic" },
        voice: { name: "marin" },
        codex: "/file/codex",
      },
      {},
      HOME,
    );
    expect(config.orchestrator.model).toBe("cli-model");
    expect(config.orchestrator.effort).toBe("high");
    expect(config.orchestrator.personality).toBe("pragmatic");
    expect(config.voice.name).toBe("marin");
    expect(config.codex).toBe("/cli/codex");
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

  test("honors CODEX_PATH; XDG_STATE_HOME does not move the workspace", () => {
    const config = resolveConfig(
      {},
      {},
      { CODEX_PATH: "/opt/codex", XDG_STATE_HOME: "/var/state" },
      HOME,
    );
    expect(config.codex).toBe("/opt/codex");
    // The workspace is the home directory, not a state path: XDG_STATE_HOME
    // moves the state directory without moving the agent.
    expect(config.orchestrator.workspace).toBe("/home/tester");
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
        codex: "~/bin/codex",
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
      codex: "~/bin/codex",
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

  test("flat pre-nesting keys are plain unknown options", () => {
    expect(() => parseJsonConfig('{"model": "m"}', "server.json")).toThrow(
      /unknown option "model"/,
    );
    expect(() => parseJsonConfig('{"voice-model": "vm"}', "server.json")).toThrow(
      /unknown option "voice-model"/,
    );
    expect(() => parseJsonConfig('{"voice": "marin"}', "server.json")).toThrow(
      /"voice" must be an object/,
    );
    expect(() => parseJsonConfig('{"orchestrator": {"voice-model": "vm"}}', "server.json")).toThrow(
      /unknown option "orchestrator.voice-model"/,
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

  // zod's object parser skips a literal own `__proto__` key, so `strictObject`
  // never lists it among its unrecognized keys. Every level that rejected
  // unknown options before the schema port must still reject this one, with the
  // same prose. The inputs are built by JSON.parse rather than object literals
  // because a `__proto__` key written in source is special-cased by the
  // language and would not create the own property this exercises.
  test("a __proto__ key is an unknown option at every strict level", () => {
    expect(() => parseJsonConfig('{"__proto__": {"polluted": true}}', "server.json")).toThrow(
      /unknown option "__proto__"; known keys: codex, accounts, orchestrator, voice/,
    );
    expect(() =>
      parseJsonConfig('{"codex": "codex", "__proto__": {"polluted": true}}', "server.json"),
    ).toThrow(/unknown option "__proto__"/);
    expect(() =>
      parseJsonConfig('{"accounts": {"__proto__": {"polluted": true}}}', "server.json"),
    ).toThrow(/unknown option "accounts.__proto__"; known keys: balance, switch-threshold/);
    expect(() =>
      parseJsonConfig('{"orchestrator": {"__proto__": {"polluted": true}}}', "server.json"),
    ).toThrow(/unknown option "orchestrator.__proto__"; known keys: workspace, dispatch/);
    expect(() =>
      parseJsonConfig('{"voice": {"__proto__": {"polluted": true}}}', "server.json"),
    ).toThrow(/unknown option "voice.__proto__"; known keys: model, name, version/);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  test("the open passthroughs stay open under a __proto__ key", () => {
    expect(
      parseJsonConfig(
        '{"orchestrator": {"extra": {"__proto__": {"x": 1}, "a": 2}}}',
        "server.json",
      ),
    ).toEqual({ orchestrator: { extra: { a: 2 } } });
    expect(
      parseJsonConfig('{"voice": {"extra": {"__proto__": {"x": 1}, "a": 2}}}', "server.json"),
    ).toEqual({ voice: { extra: { a: 2 } } });
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
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
        codex: "/bin/codex",
      }),
    ).toEqual({
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

// ---------------------------------------------------------------------------
// Characterization ahead of the zod port. These pin current behavior and that
// errors NAME the offending key path — never exact message prose, which the
// port may replace with zod-derived strings.
// ---------------------------------------------------------------------------

describe("parseJsonConfig characterization", () => {
  test("rejects scalar documents", () => {
    for (const text of ["3", '"x"', "true"]) {
      expect(() => parseJsonConfig(text, "server.json")).toThrow(ConfigError);
    }
  });

  test("errors carry the source they were parsed from", () => {
    expect(() => parseJsonConfig('{"nope": 1}', "/etc/avn/server.json")).toThrow(
      /\/etc\/avn\/server\.json/,
    );
  });

  test("tolerates $schema alongside real keys, whatever its value", () => {
    expect(
      parseJsonConfig('{"$schema": "./server.schema.json", "codex": "c"}', "server.json"),
    ).toEqual({ codex: "c" });
    // The value is never inspected; even a non-string is ignored.
    expect(parseJsonConfig('{"$schema": 123}', "server.json")).toEqual({});
  });

  test("codex must be a string, named on rejection", () => {
    expect(parseJsonConfig('{"codex": "~/bin/codex"}', "server.json")).toEqual({
      codex: "~/bin/codex",
    });
    expect(() => parseJsonConfig('{"codex": 3}', "server.json")).toThrow(/codex/);
  });

  test("accounts: shape, balance type, and unknown keys are named", () => {
    expect(
      parseJsonConfig('{"accounts": {"balance": true, "switch-threshold": 80}}', "server.json"),
    ).toEqual({ accounts: { balance: true, "switch-threshold": 80 } });
    expect(() => parseJsonConfig('{"accounts": 3}', "server.json")).toThrow(/accounts/);
    expect(() => parseJsonConfig('{"accounts": {"balance": "yes"}}', "server.json")).toThrow(
      /accounts\.balance/,
    );
    expect(() => parseJsonConfig('{"accounts": {"nope": 1}}', "server.json")).toThrow(
      /accounts\.nope/,
    );
  });

  test("accounts.switch-threshold is an integer between 50 and 100", () => {
    for (const threshold of [50, 95, 100]) {
      expect(
        parseJsonConfig(`{"accounts": {"switch-threshold": ${threshold}}}`, "server.json"),
      ).toEqual({ accounts: { "switch-threshold": threshold } });
    }
    for (const bad of ["49", "101", "95.5", '"95"', "true"]) {
      expect(() =>
        parseJsonConfig(`{"accounts": {"switch-threshold": ${bad}}}`, "server.json"),
      ).toThrow(/accounts\.switch-threshold/);
    }
  });

  test("orchestrator string options are named on type errors", () => {
    const keys = ["workspace", "model", "effort", "permissions", "model-provider", "service-tier"];
    for (const key of keys) {
      expect(parseJsonConfig(`{"orchestrator": {"${key}": "v"}}`, "server.json")).toEqual({
        orchestrator: { [key]: "v" },
      });
      expect(() => parseJsonConfig(`{"orchestrator": {"${key}": 3}}`, "server.json")).toThrow(
        new RegExp(`orchestrator\\.${key}`),
      );
    }
  });

  test("orchestrator enum options validate at file level with the path named", () => {
    const cases: Array<[string, string]> = [
      ["sandbox", "workspace-write"],
      ["approval-policy", "on-request"],
      ["approvals-reviewer", "auto_review"],
      ["history-mode", "paginated"],
    ];
    for (const [key, good] of cases) {
      expect(parseJsonConfig(`{"orchestrator": {"${key}": "${good}"}}`, "server.json")).toEqual({
        orchestrator: { [key]: good },
      });
      expect(() => parseJsonConfig(`{"orchestrator": {"${key}": "bogus"}}`, "server.json")).toThrow(
        new RegExp(`orchestrator\\.${key}`),
      );
    }
  });

  test("orchestrator.ephemeral must be boolean", () => {
    expect(parseJsonConfig('{"orchestrator": {"ephemeral": true}}', "server.json")).toEqual({
      orchestrator: { ephemeral: true },
    });
    expect(() => parseJsonConfig('{"orchestrator": {"ephemeral": 1}}', "server.json")).toThrow(
      /orchestrator\.ephemeral/,
    );
  });

  test("orchestrator.runtime-workspace-roots is a string list with indexed errors", () => {
    expect(
      parseJsonConfig(
        '{"orchestrator": {"runtime-workspace-roots": ["~/a", "/b"]}}',
        "server.json",
      ),
    ).toEqual({ orchestrator: { "runtime-workspace-roots": ["~/a", "/b"] } });
    expect(() =>
      parseJsonConfig('{"orchestrator": {"runtime-workspace-roots": "a"}}', "server.json"),
    ).toThrow(/orchestrator\.runtime-workspace-roots/);
    expect(() =>
      parseJsonConfig('{"orchestrator": {"runtime-workspace-roots": ["a", 3]}}', "server.json"),
    ).toThrow(/runtime-workspace-roots\[1\]/);
  });

  test("orchestrator.config and orchestrator.extra are open passthroughs", () => {
    // These forward to the codex key space; unknown nested keys must survive.
    const document = {
      orchestrator: {
        config: { anything: { nested: true }, "weird key": [1, 2] },
        extra: { experimental: "yes", list: ["a"] },
      },
    };
    expect(parseJsonConfig(JSON.stringify(document), "server.json")).toEqual(document);
    expect(() => parseJsonConfig('{"orchestrator": {"config": 3}}', "server.json")).toThrow(
      /orchestrator\.config/,
    );
    expect(() => parseJsonConfig('{"orchestrator": {"extra": []}}', "server.json")).toThrow(
      /orchestrator\.extra/,
    );
  });

  test("voice string options are named on type errors", () => {
    for (const key of ["model", "name", "codex-response-item-prefix"]) {
      expect(parseJsonConfig(`{"voice": {"${key}": "v"}}`, "server.json")).toEqual({
        voice: { [key]: "v" },
      });
      expect(() => parseJsonConfig(`{"voice": {"${key}": 3}}`, "server.json")).toThrow(
        new RegExp(`voice\\.${key}`),
      );
    }
  });

  test("voice boolean options are named on type errors", () => {
    const keys = [
      "include-startup-context",
      "delegation-ack-filler",
      "codex-responses-as-items",
      "flush-transcript-tail-on-session-end",
      "client-managed-handoffs",
    ];
    for (const key of keys) {
      expect(parseJsonConfig(`{"voice": {"${key}": false}}`, "server.json")).toEqual({
        voice: { [key]: false },
      });
      expect(() => parseJsonConfig(`{"voice": {"${key}": "no"}}`, "server.json")).toThrow(
        new RegExp(`voice\\.${key}`),
      );
    }
  });

  test("voice.codex-response-handoff-mode is an enum with the path named", () => {
    expect(
      parseJsonConfig('{"voice": {"codex-response-handoff-mode": "bemTags"}}', "server.json"),
    ).toEqual({ voice: { "codex-response-handoff-mode": "bemTags" } });
    expect(() =>
      parseJsonConfig('{"voice": {"codex-response-handoff-mode": "loud"}}', "server.json"),
    ).toThrow(/voice\.codex-response-handoff-mode/);
  });

  test("voice unknown keys are named", () => {
    expect(() => parseJsonConfig('{"voice": {"nope": 1}}', "server.json")).toThrow(/voice\.nope/);
  });

  test("channel prefixes map arbitrary channel names to string lists", () => {
    expect(
      parseJsonConfig(
        '{"voice": {"codex-response-handoff-channel-prefixes": {"final": ["[R] "], "someFutureChannel": []}}}',
        "server.json",
      ),
    ).toEqual({
      voice: {
        "codex-response-handoff-channel-prefixes": { final: ["[R] "], someFutureChannel: [] },
      },
    });
    expect(() =>
      parseJsonConfig('{"voice": {"codex-response-handoff-channel-prefixes": 3}}', "server.json"),
    ).toThrow(/voice\.codex-response-handoff-channel-prefixes/);
    expect(() =>
      parseJsonConfig(
        '{"voice": {"codex-response-handoff-channel-prefixes": {"final": "x"}}}',
        "server.json",
      ),
    ).toThrow(/codex-response-handoff-channel-prefixes\.final/);
    expect(() =>
      parseJsonConfig(
        '{"voice": {"codex-response-handoff-channel-prefixes": {"final": [3]}}}',
        "server.json",
      ),
    ).toThrow(/codex-response-handoff-channel-prefixes\.final\[0\]/);
  });

  test("voice.extra is an open passthrough", () => {
    const document = { voice: { extra: { initialItems: [{ role: "user", text: "hi" }] } } };
    expect(parseJsonConfig(JSON.stringify(document), "server.json")).toEqual(document);
    expect(() => parseJsonConfig('{"voice": {"extra": null}}', "server.json")).toThrow(
      /voice\.extra/,
    );
  });
});

describe("cliToConfigValues characterization", () => {
  test("names the offending flag", () => {
    expect(() => cliToConfigValues({ sandbox: "yolo" })).toThrow(/--sandbox/);
    expect(() => cliToConfigValues({ "approval-policy": "always" })).toThrow(/--approval-policy/);
    expect(() => cliToConfigValues({ nope: "x" })).toThrow(ConfigError);
    expect(() => cliToConfigValues({ nope: "x" })).toThrow(/--nope/);
  });
});

describe("resolveConfig characterization", () => {
  test("accounts defaults, file values, and CLI precedence", () => {
    expect(resolveConfig({}, {}, {}, HOME).accounts).toEqual({
      balance: false,
      switchThreshold: 95,
    });
    expect(
      resolveConfig({}, { accounts: { balance: true, "switch-threshold": 80 } }, {}, HOME).accounts,
    ).toEqual({ balance: true, switchThreshold: 80 });
    expect(
      resolveConfig(
        { accounts: { "switch-threshold": 60 } },
        { accounts: { "switch-threshold": 80 } },
        {},
        HOME,
      ).accounts.switchThreshold,
    ).toBe(60);
  });

  test("codex: CLI beats file beats $CODEX_PATH beats the bare default", () => {
    const env = { CODEX_PATH: "/env/codex" };
    expect(resolveConfig({ codex: "/cli/codex" }, { codex: "/file/codex" }, env, HOME).codex).toBe(
      "/cli/codex",
    );
    expect(resolveConfig({}, { codex: "/file/codex" }, env, HOME).codex).toBe("/file/codex");
    expect(resolveConfig({}, {}, env, HOME).codex).toBe("/env/codex");
    expect(resolveConfig({}, {}, {}, HOME).codex).toBe("codex");
  });

  test("debug defaults to false and follows the option", () => {
    expect(resolveConfig({}, {}, {}, HOME).debug).toBe(false);
    expect(resolveConfig({}, {}, {}, HOME, { debug: true }).debug).toBe(true);
  });

  test("configDir default honors XDG_CONFIG_HOME", () => {
    expect(resolveConfig({}, {}, { XDG_CONFIG_HOME: "/xdg" }, HOME).configDir).toBe(
      "/xdg/agentvoice",
    );
  });

  test("every optional leaf stays undefined when unset", () => {
    // Anything undefined here is omitted from the codex payloads entirely
    // (params.ts drops undefined); resolution must never default-inject.
    const { orchestrator, voice } = resolveConfig({}, {}, {}, HOME);
    const orchestratorLeaves = [
      "dispatch",
      "dispatchReports",
      "model",
      "effort",
      "personality",
      "approvalsReviewer",
      "permissions",
      "modelProvider",
      "serviceTier",
      "ephemeral",
      "historyMode",
      "runtimeWorkspaceRoots",
      "config",
      "extra",
    ] as const;
    for (const key of orchestratorLeaves) expect(orchestrator[key]).toBeUndefined();
    const voiceLeaves = [
      "model",
      "name",
      "includeStartupContext",
      "delegationAckFiller",
      "codexResponseHandoffMode",
      "codexResponsesAsItems",
      "codexResponseItemPrefix",
      "codexResponseHandoffChannelPrefixes",
      "flushTranscriptTailOnSessionEnd",
      "clientManagedHandoffs",
      "extra",
    ] as const;
    for (const key of voiceLeaves) expect(voice[key]).toBeUndefined();
  });

  test("dispatch-reports: false needs no dispatch", () => {
    const config = resolveConfig({}, { orchestrator: { "dispatch-reports": false } }, {}, HOME);
    expect(config.orchestrator.dispatchReports).toBe(false);
    expect(config.orchestrator.dispatch).toBeUndefined();
  });

  test("config and extra pass through resolution unchanged", () => {
    const file = {
      orchestrator: {
        config: { model_reasoning_summary_format: "experimental" },
        extra: { anything: ["goes"] },
      },
      voice: { extra: { initialItems: [] } },
    };
    const config = resolveConfig({}, file, {}, HOME);
    expect(config.orchestrator.config).toEqual({ model_reasoning_summary_format: "experimental" });
    expect(config.orchestrator.extra).toEqual({ anything: ["goes"] });
    expect(config.voice.extra).toEqual({ initialItems: [] });
  });
});

describe("loadConfigFile characterization", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "avn-load-"));
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test("reads and parses an existing file, naming it in errors", async () => {
    const good = join(directory, "good-server.json");
    writeFileSync(good, '{"codex": "/bin/codex", "voice": {"name": "marin"}}');
    expect(await loadConfigFile(good, false)).toEqual({
      codex: "/bin/codex",
      voice: { name: "marin" },
    });

    const bad = join(directory, "bad-server.json");
    writeFileSync(bad, '{"voice": {"nope": 1}}');
    await expect(loadConfigFile(bad, true)).rejects.toThrow(/voice\.nope/);
    await expect(loadConfigFile(bad, true)).rejects.toThrow(/bad-server\.json/);
  });
});

describe("parseArgs characterization", () => {
  test("a bare word is an unknown option", () => {
    expect(() => parseArgs(["foo"])).toThrow(UsageError);
  });
});

describe("parseConsoleCommand", () => {
  test("defaults to system devices, resume, and no debug", () => {
    expect(parseConsoleCommand([])).toEqual({
      help: false,
      options: { debug: false, fresh: false },
      parsed: { values: {}, debug: false, fresh: false, help: false },
    });
  });

  test("parses device indices, fresh, and debug; devices stay console-side", () => {
    const command = parseConsoleCommand([
      "--device",
      "1",
      "--output-device=2",
      "--fresh",
      "--debug",
      "--model",
      "m",
    ]);
    if (command.help) throw new Error("expected a non-help parse");
    expect(command.options).toEqual({
      deviceIndex: 1,
      outputDeviceIndex: 2,
      debug: true,
      fresh: true,
    });
    expect(command.parsed.values).toEqual({ model: "m" });
  });

  test("rejects the removed two-app flags", () => {
    for (const flag of ["--url", "--token", "--port"]) {
      expect(() => parseConsoleCommand([`${flag}=x`])).toThrow(UsageError);
    }
  });

  test("rejects malformed and out-of-range device indices", () => {
    for (const value of ["1junk", "1.5", "-1", "+1", "", "2147483648"]) {
      expect(() => parseConsoleCommand([`--device=${value}`])).toThrow(
        /must be a non-negative 32-bit integer/,
      );
    }
  });

  test("lets --help bypass value validation after syntax is parsed", () => {
    expect(parseConsoleCommand(["--device=bad", "--help"])).toEqual({ help: true });
  });
});
