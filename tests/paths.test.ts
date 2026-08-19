import { describe, expect, test } from "bun:test";
import {
  controlSocketPath,
  defaultConfigPath,
  expandTilde,
  pairedDevicesFilePath,
  remoteProfileFilePath,
  residentDirectory,
  residentSocketPath,
  residentStateFilePath,
  serverIdentityCertificatePath,
  serverIdentityKeyPath,
  stateDirectory,
  threadStateFilePath,
  workersStateFilePath,
} from "../src/paths.ts";

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
    expect(controlSocketPath({}, HOME)).toBe("/home/tester/.local/state/agentvoice/control.sock");
    expect(serverIdentityKeyPath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/server/identity-key.pem",
    );
    expect(serverIdentityCertificatePath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/server/identity-cert.pem",
    );
    expect(pairedDevicesFilePath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/server/paired-devices.json",
    );
    expect(remoteProfileFilePath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/remote.json",
    );
    expect(residentDirectory({}, HOME)).toBe("/home/tester/.local/state/agentvoice/resident");
    expect(residentSocketPath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/resident/app-server.sock",
    );
    expect(residentStateFilePath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/resident/resident.json",
    );
    expect(threadStateFilePath({}, HOME)).toBe("/home/tester/.local/state/agentvoice/thread.json");
    expect(workersStateFilePath({}, HOME)).toBe(
      "/home/tester/.local/state/agentvoice/workers.json",
    );
  });

  test("expandTilde only rewrites leading ~", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/x", HOME)).toBe("/home/tester/x");
    expect(expandTilde("/a/~/b", HOME)).toBe("/a/~/b");
  });
});
