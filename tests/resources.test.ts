import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSkillPolicy, resourcesRoot } from "../src/resources.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("fixed fleet resources", () => {
  test("name-enables every qualified plugin skill", () => {
    const scratch = mkdtempSync(join(tmpdir(), "agentvoice-resources-"));
    roots.push(scratch);
    const root = join(scratch, "resources");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "managed-skills.txt"), "wiki\ncollab\n");
    const env = { AGENTSTART_RESOURCES_ROOT: root };
    expect(resourcesRoot(env, "/unused")).toBe(root);
    expect(fleetSkillPolicy(env, "/unused")).toEqual([
      { name: "agent:collab", enabled: true },
      { name: "agent:wiki", enabled: true },
    ]);
  });

  test("rejects a relative override and a missing install", () => {
    expect(() => resourcesRoot({ AGENTSTART_RESOURCES_ROOT: "relative" }, "/home/test")).toThrow(
      "absolute path",
    );
    expect(() => fleetSkillPolicy({}, "/missing-home")).toThrow("scripts/install.sh --install");
  });
});
