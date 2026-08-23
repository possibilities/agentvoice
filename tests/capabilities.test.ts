import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesRoot, commonSkillsRoot, withCommonSkills } from "../src/capabilities.ts";
import { DISABLE_AGENTSTART_COMPATIBILITY_PLUGIN, residentArgv } from "../src/resident/contract.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("AgentStart common capability pack", () => {
  test("resolves the default and an absolute override", () => {
    expect(capabilitiesRoot({}, "/home/tester")).toBe(
      "/home/tester/.local/share/agentstart/capabilities",
    );
    expect(capabilitiesRoot({ AGENTSTART_CAPABILITIES_ROOT: "/srv/caps" }, "/home/tester")).toBe(
      "/srv/caps",
    );
    expect(() =>
      capabilitiesRoot({ AGENTSTART_CAPABILITIES_ROOT: "relative/caps" }, "/home/tester"),
    ).toThrow("must be an absolute path");
  });

  test("requires the common skills directory and explains how to restore it", () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-capabilities-"));
    scratch.push(root);
    const env = { AGENTSTART_CAPABILITIES_ROOT: root };
    expect(() => commonSkillsRoot(env, "/unused")).toThrow("scripts/install.sh --install");
    mkdirSync(join(root, "packs", "common", "skills"), { recursive: true });
    expect(commonSkillsRoot(env, "/unused")).toBe(join(root, "packs", "common", "skills"));
  });

  test("sets the skill root before starting or resuming a thread", async () => {
    const calls: string[] = [];
    const attachment = {
      async request(method: string, params: unknown): Promise<unknown> {
        calls.push(`${method}:${JSON.stringify(params)}`);
        return {};
      },
    };
    const result = await withCommonSkills(
      attachment,
      async () => {
        calls.push("thread/open");
        return "thread-id";
      },
      "/caps/packs/common/skills",
    );
    expect(result).toBe("thread-id");
    expect(calls).toEqual([
      'skills/extraRoots/set:{"extraRoots":["/caps/packs/common/skills"]}',
      "thread/open",
    ]);
  });

  test("resident disables the desktop compatibility projection", () => {
    expect(residentArgv("/bin/codex", "/tmp/resident.sock")).toEqual([
      "/bin/codex",
      "-c",
      DISABLE_AGENTSTART_COMPATIBILITY_PLUGIN,
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "unix:///tmp/resident.sock",
    ]);
  });
});
