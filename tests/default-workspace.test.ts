import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/core/config.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { pinCallWorkspace } from "../src/frontend/server.ts";
import { parseArgs } from "../src/main.ts";
import { stateDirectory } from "../src/paths.ts";
import { currentWorkspace, workspaceBase } from "../src/workspace.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-workspace-")));
  roots.push(root);
  return { root, state: join(root, "state") };
}
const later = "2099-01-01T00-00-00.000Z-11111111-1111-1111-1111-111111111111";

test("XDG namespacing and first generation creation are private and stable", () => {
  const f = fixture();
  expect(stateDirectory({}, f.root)).toBe(join(f.root, ".local/state/agentvoice"));
  expect(stateDirectory({ XDG_STATE_HOME: f.root }, "/ignored")).toBe(join(f.root, "agentvoice"));
  expect(workspaceBase(f.state)).toBe(join(f.state, "default/workspaces"));
  const workspace = currentWorkspace(f.state);
  expect(currentWorkspace(f.state)).toBe(workspace);
  expect(readdirSync(workspaceBase(f.state))).toHaveLength(1);
  expect(readdirSync(workspace)).toEqual([]);
  expect(statSync(workspace).mode & 0o777).toBe(0o700);
});

test("newest generation name wins despite mutable mtimes; active call provenance stays pinned", () => {
  const f = fixture();
  const first = currentWorkspace(f.state);
  const provenance = {
    parsed: parseArgs([]),
    options: { fresh: false, continue: false, debug: false },
    launchCwd: f.root,
  };
  const pinned = pinCallWorkspace(provenance, first);
  const second = join(workspaceBase(f.state), later);
  mkdirSync(second, { mode: 0o755 });
  writeFileSync(join(first, "notes"), "old files remain");
  utimesSync(first, new Date("2100-01-01"), new Date("2100-01-01"));
  expect(currentWorkspace(f.state)).toBe(second);
  expect(pinned.parsed.values["workspace"]).toBe(first);
  expect(provenance.parsed.values["workspace"]).toBeUndefined();
  expect(frontendSocketPath(f.state)).not.toBe(frontendSocketPath(f.state, first));
  expect(existsSync(join(first, "notes"))).toBe(true);
});

test("unsafe newest generations fail rather than falling back or following links", () => {
  const f = fixture();
  currentWorkspace(f.state);
  const second = join(workspaceBase(f.state), later);
  symlinkSync(f.root, second);
  expect(() => currentWorkspace(f.state)).toThrow("Unsafe directory");
  rmSync(second);
  mkdirSync(second, { mode: 0o700 });
  chmodSync(second, 0o777);
  expect(() => currentWorkspace(f.state)).toThrow("Unsafe directory");
});

test("explicit CLI and file workspaces override the supplied managed default", () => {
  const options = { launchCwd: "/launch", defaultWorkspace: "/state/default/workspaces/current" };
  const file = { orchestrator: { workspace: "project" } };
  expect(resolveConfig({}, {}, {}, "/home", options).orchestrator.workspace).toBe(
    options.defaultWorkspace,
  );
  expect(resolveConfig({}, file, {}, "/home", options).orchestrator.workspace).toBe(
    "/launch/project",
  );
  expect(
    resolveConfig({ orchestrator: { workspace: "other" } }, file, {}, "/home", options).orchestrator
      .workspace,
  ).toBe("/launch/other");
});

test("concurrent processes agree on exactly one initial generation", async () => {
  const f = fixture();
  const script = `import { currentWorkspace } from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).pathname)}; console.log(currentWorkspace(process.env["TEST_STATE"]!));`;
  const options = {
    env: { ...process.env, TEST_STATE: f.state },
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    signal: AbortSignal.timeout(5000),
  };
  const first = Bun.spawn([process.execPath, "-e", script], options);
  const second = Bun.spawn([process.execPath, "-e", script], options);
  const [firstCode, secondCode, firstPath, secondPath] = await Promise.all([
    first.exited,
    second.exited,
    new Response(first.stdout).text(),
    new Response(second.stdout).text(),
  ]);
  expect(firstCode).toBe(0);
  expect(secondCode).toBe(0);
  expect(firstPath).toBe(secondPath);
  expect(readdirSync(workspaceBase(f.state))).toHaveLength(1);
});
