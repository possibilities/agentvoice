import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilitiesRoot,
  commonSkillsRoot,
  compatibilityAliasPolicy,
  withCommonSkills,
} from "../src/capabilities.ts";
import { residentArgv } from "../src/resident/contract.ts";

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

  test("resident carries no skill policy of its own", () => {
    // Plugin enablement is persistent user/profile policy in codex, so the
    // session flag this once passed never disabled anything. Suppression is
    // per thread now, where it demonstrably works.
    expect(residentArgv("/bin/codex", "/tmp/resident.sock")).toEqual([
      "/bin/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
      "--listen",
      "unix:///tmp/resident.sock",
    ]);
  });

  test("names every compatibility alias to disable, and nothing when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-aliases-"));
    scratch.push(root);
    const env = { AGENTSTART_CAPABILITIES_ROOT: root };
    expect(compatibilityAliasPolicy(env, "/unused")).toEqual([]);

    const skills = join(root, "compatibility", "codex-marketplace", "plugins", "agent", "skills");
    for (const name of ["wiki", "collab"]) mkdirSync(join(skills, name), { recursive: true });
    expect(compatibilityAliasPolicy(env, "/unused")).toEqual([
      { name: "agent:collab", enabled: false },
      { name: "agent:wiki", enabled: false },
    ]);
  });
});
