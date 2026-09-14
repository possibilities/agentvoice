import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryRoleStatus, readDirectoryRoleContent } from "../src/core/role-content.ts";
import { prepareRuntime } from "../src/core/runtime.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "av-role-content-"));
  roots.push(root);
  const role = join(root, "role");
  mkdirSync(role);
  return { root, role };
}

test("resolved bytes and logical paths determine digests; link targets and unrelated files do not", () => {
  const { root, role } = fixture();
  const target = join(root, "prompt");
  writeFileSync(target, "private prompt\n");
  symlinkSync(target, join(role, "APPEND_SYSTEM_PROMPT.md"));
  const skills = join(root, "shared-skills");
  mkdirSync(skills);
  symlinkSync(skills, join(role, "skills"));
  mkdirSync(join(skills, "empty"));
  writeFileSync(join(skills, "SKILL.md"), "skill bytes");
  writeFileSync(
    join(role, "mcp.json"),
    '{"mcpServers":{"tool":{"command":"secret-command","env":{"TOKEN":"secret-value"}}}}',
  );
  const initial = readDirectoryRoleContent(role);
  const copy = join(root, "copy");
  mkdirSync(copy);
  writeFileSync(join(copy, "APPEND_SYSTEM_PROMPT.md"), "private prompt\n");
  symlinkSync(skills, join(copy, "skills"));
  writeFileSync(
    join(copy, "mcp.json"),
    '{"mcpServers":{"tool":{"command":"secret-command","env":{"TOKEN":"secret-value"}}}}',
  );
  expect(readDirectoryRoleContent(copy)).toEqual(initial);
  writeFileSync(join(role, "README.md"), "not an input");
  expect(readDirectoryRoleContent(role)).toEqual(initial);
  writeFileSync(target, "private prompt changed\n");
  const promptChange = readDirectoryRoleContent(role);
  expect(promptChange.prompts).not.toBe(initial.prompts);
  expect(promptChange.mcp).toBe(initial.mcp);
  expect(promptChange.skills).toBe(initial.skills);
  chmodSync(join(skills, "SKILL.md"), 0o755);
  expect(readDirectoryRoleContent(role).skills).not.toBe(initial.skills);
  renameSync(join(skills, "SKILL.md"), join(skills, "renamed.md"));
  const status = directoryRoleStatus({ path: role, digests: initial }, 2);
  expect(status.stale).toBe(true);
  expect(status.loaded).toEqual({ generation: 2, digests: initial });
  for (const secret of [
    "private prompt",
    "secret-command",
    "secret-value",
    "shared-skills",
    "renamed.md",
  ])
    expect(JSON.stringify(status)).not.toContain(secret);
});

test("missing sources, broken links, cycles and oversized inputs return bounded status errors", () => {
  const { role } = fixture();
  const info = { path: role, digests: readDirectoryRoleContent(role) };
  symlinkSync(role, join(role, "skills"));
  expect(directoryRoleStatus(info, 1)).toMatchObject({
    stale: null,
    error: "Directory role content is unavailable or exceeds observation limits",
  });
  rmSync(join(role, "skills"));
  symlinkSync(join(role, "missing-secret-target"), join(role, "mcp.json"));
  const status = directoryRoleStatus(info, 1);
  expect(status.desired).toBeUndefined();
  expect(JSON.stringify(status)).not.toContain("missing-secret-target");
  rmSync(join(role, "mcp.json"));
  writeFileSync(join(role, "mcp.json"), Buffer.alloc(32 * 1024 * 1024 + 1));
  expect(directoryRoleStatus(info, 1).stale).toBeNull();
  rmSync(role, { recursive: true });
  expect(directoryRoleStatus(info, 1).stale).toBeNull();
});

test("preflight digests exactly the raw prompt/mode/MCP bytes it loads and initial skill tree", async () => {
  const h = runtimeHarness({ role: "./role" });
  const role = join(h.directory, "role");
  mkdirSync(join(role, "skills", "empty"), { recursive: true });
  writeFileSync(join(role, "SYSTEM_PROMPT.md"), "shadowed general input");
  writeFileSync(join(role, "VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md"), "effective input\n");
  writeFileSync(join(role, "VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md"), "mode bytes\n");
  writeFileSync(join(role, "mcp.json"), '{ "mcpServers": {} }\n');
  const snapshot = await prepareRuntime(h.config);
  try {
    expect(snapshot.directoryRole).toEqual({ path: role, digests: readDirectoryRoleContent(role) });
    expect(snapshot.prompts.orchestratorBaseInstructions).toBe("effective input\n");
    expect(snapshot.role?.skillsRoot).toBe(join(role, "skills"));
    const original = structuredClone(snapshot.directoryRole);
    writeFileSync(join(role, "mcp.json"), '{"mcpServers":{}}');
    expect(snapshot.directoryRole).toEqual(original);
    expect(readDirectoryRoleContent(role).mcp).not.toBe(original!.digests.mcp);
  } finally {
    snapshot.dispose?.();
    await h.cleanup();
  }
});

test("preflight observation failures omit skill target paths and contents", async () => {
  const h = runtimeHarness({ role: "./role" });
  const role = join(h.directory, "role");
  mkdirSync(join(role, "skills"), { recursive: true });
  symlinkSync(join(role, "private-missing-target"), join(role, "skills", "broken"));
  try {
    await expect(prepareRuntime(h.config)).rejects.toThrow(
      "Directory role content observation failed: unavailable source or observation limits",
    );
  } finally {
    await h.cleanup();
  }
});
