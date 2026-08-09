import { describe, expect, test } from "bun:test";
import { defaultConfigPath, expandTilde, stateDirectory, tokenPath } from "../src/paths.ts";

const HOME = "/home/tester";

describe("paths", () => {
  test("stateDirectory and defaultConfigPath follow XDG with absolute overrides", () => {
    expect(stateDirectory({}, HOME)).toBe("/home/tester/.local/state/agentvoice");
    expect(stateDirectory({ XDG_STATE_HOME: "relative" }, HOME)).toBe(
      "/home/tester/.local/state/agentvoice",
    );
    expect(defaultConfigPath({}, HOME)).toBe("/home/tester/.config/agentvoice/server.json");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/etc/xdg" }, HOME)).toBe(
      "/etc/xdg/agentvoice/server.json",
    );
    expect(tokenPath({}, HOME)).toBe("/home/tester/.local/state/agentvoice/token");
  });

  test("expandTilde only rewrites leading ~", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/x", HOME)).toBe("/home/tester/x");
    expect(expandTilde("/a/~/b", HOME)).toBe("/a/~/b");
  });
});
