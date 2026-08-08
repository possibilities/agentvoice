import { describe, expect, test } from "bun:test";
import { defaultConfigPath, expandTilde, stateDirectory } from "../src/paths.ts";

const HOME = "/home/tester";

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
