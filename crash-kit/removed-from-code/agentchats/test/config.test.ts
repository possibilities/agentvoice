import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentchatsConfigPath,
  decodeAgentchatsConfig,
  loadAgentchatsConfig,
} from "../src/tui/config.ts";

const temp = mkdtempSync(join(tmpdir(), "agentchats-config-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("Agentchats config", () => {
  test("resolves the XDG path, falling back to the home config directory", () => {
    expect(agentchatsConfigPath({ HOME: "/Users/op" })).toBe(
      "/Users/op/.config/agentchats/config.json",
    );
    expect(agentchatsConfigPath({ HOME: "/Users/op", XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/agentchats/config.json",
    );
    expect(agentchatsConfigPath({ HOME: "/Users/op", XDG_CONFIG_HOME: "relative" })).toBe(
      "/Users/op/.config/agentchats/config.json",
    );
  });

  test("decodes and deduplicates configured Codex originators", () => {
    const config = decodeAgentchatsConfig({
      auxiliary: { "codex-originators": [" agentvoice ", "agentvoice"] },
    });
    expect([...config.auxiliaryCodexOriginators]).toEqual(["agentvoice"]);
  });

  test("rejects misspelled keys and malformed originators", () => {
    expect(() => decodeAgentchatsConfig({ auxilliary: {} })).toThrow("unknown key");
    expect(() =>
      decodeAgentchatsConfig({ auxiliary: { "codex-originators": [""] } }),
    ).toThrow("non-empty string");
  });

  test("an absent file is empty while a present file is loaded", async () => {
    const absent = await loadAgentchatsConfig({
      HOME: temp,
      XDG_CONFIG_HOME: join(temp, "absent"),
    });
    expect(absent.auxiliaryCodexOriginators.size).toBe(0);

    const xdg = join(temp, "present");
    mkdirSync(join(xdg, "agentchats"), { recursive: true });
    writeFileSync(
      join(xdg, "agentchats", "config.json"),
      JSON.stringify({ auxiliary: { "codex-originators": ["agentvoice"] } }),
    );
    const present = await loadAgentchatsConfig({ HOME: temp, XDG_CONFIG_HOME: xdg });
    expect(present.auxiliaryCodexOriginators.has("agentvoice")).toBe(true);
  });
});
