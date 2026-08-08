import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  defaultConfigPath,
  expandTilde,
  parseYamlConfig,
  resolveConfig,
  stateDirectory,
} from "../src/config.ts";
import { parseArgs, UsageError } from "../src/main.ts";

const HOME = "/home/tester";

describe("resolveConfig", () => {
  test("applies defaults when nothing is set", () => {
    const config = resolveConfig({}, {}, {}, HOME);
    expect(config.port).toBe(7890);
    expect(config.sandbox).toBe("danger-full-access");
    expect(config.approvalPolicy).toBe("never");
    expect(config.workspace).toBe("/home/tester/.local/state/agentvoicenext/workspace");
    expect(config.codex).toBe("codex");
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
  });

  test("CLI beats file beats default", () => {
    const config = resolveConfig(
      { model: "cli-model", port: "9000" },
      { model: "file-model", effort: "high", port: 9999 },
      {},
      HOME,
    );
    expect(config.model).toBe("cli-model");
    expect(config.effort).toBe("high");
    expect(config.port).toBe(9000);
  });

  test("honors CODEX_PATH and XDG_STATE_HOME", () => {
    const config = resolveConfig(
      {},
      {},
      { CODEX_PATH: "/opt/codex", XDG_STATE_HOME: "/var/state" },
      HOME,
    );
    expect(config.codex).toBe("/opt/codex");
    expect(config.workspace).toBe("/var/state/agentvoicenext/workspace");
  });

  test("expands tilde in workspace and codex paths", () => {
    const config = resolveConfig({ workspace: "~/w", codex: "~/bin/codex" }, {}, {}, HOME);
    expect(config.workspace).toBe("/home/tester/w");
    expect(config.codex).toBe("/home/tester/bin/codex");
  });

  test("rejects invalid sandbox, approval policy, and port", () => {
    expect(() => resolveConfig({ sandbox: "yolo" }, {}, {}, HOME)).toThrow(ConfigError);
    expect(() => resolveConfig({ "approval-policy": "always" }, {}, {}, HOME)).toThrow(ConfigError);
    expect(() => resolveConfig({ port: "0" }, {}, {}, HOME)).toThrow(ConfigError);
    expect(() => resolveConfig({ port: "nope" }, {}, {}, HOME)).toThrow(ConfigError);
  });
});

describe("parseYamlConfig", () => {
  test("parses known keys", () => {
    const values = parseYamlConfig(
      "model: gpt-5.3-codex\nvoice-model: gpt-realtime\nport: 9001\n",
      "server.yaml",
    );
    expect(values).toEqual({
      model: "gpt-5.3-codex",
      "voice-model": "gpt-realtime",
      port: 9001,
    });
  });

  test("empty file yields no values", () => {
    expect(parseYamlConfig("", "server.yaml")).toEqual({});
    expect(parseYamlConfig("# comments only\n", "server.yaml")).toEqual({});
  });

  test("rejects unknown keys and non-mapping documents", () => {
    expect(() => parseYamlConfig("modle: typo\n", "server.yaml")).toThrow(/unknown option "modle"/);
    expect(() => parseYamlConfig("- a\n- b\n", "server.yaml")).toThrow(ConfigError);
  });
});

describe("paths", () => {
  test("stateDirectory and defaultConfigPath follow XDG with absolute overrides", () => {
    expect(stateDirectory({}, HOME)).toBe("/home/tester/.local/state/agentvoicenext");
    expect(stateDirectory({ XDG_STATE_HOME: "relative" }, HOME)).toBe(
      "/home/tester/.local/state/agentvoicenext",
    );
    expect(defaultConfigPath({}, HOME)).toBe("/home/tester/.config/agentvoicenext/server.yaml");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/etc/xdg" }, HOME)).toBe(
      "/etc/xdg/agentvoicenext/server.yaml",
    );
  });

  test("expandTilde only rewrites leading ~", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/x", HOME)).toBe("/home/tester/x");
    expect(expandTilde("/a/~/b", HOME)).toBe("/a/~/b");
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
