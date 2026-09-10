import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLaunchConfig } from "../src/core/launch-config.ts";
import { realtimeParams, threadParams } from "../src/core/params.ts";
import { prepareRuntime } from "../src/core/runtime.ts";
import { parseArgs } from "../src/main.ts";
import { dataDirectory } from "../src/paths.ts";
import { runRoleCommand } from "../src/roles/cli.ts";
import { roleImpact } from "../src/roles/impact.ts";
import {
  captureFiles,
  createRole,
  materializeRole,
  type RoleBundle,
  readRole,
  rolePath,
  writeVoice,
} from "../src/roles/store.ts";

const roots: string[] = [];
const environment = { data: process.env["XDG_DATA_HOME"], cache: process.env["XDG_CACHE_HOME"] };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [
    ["XDG_DATA_HOME", environment.data],
    ["XDG_CACHE_HOME", environment.cache],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-role-db-")));
  roots.push(root);
  process.env["XDG_DATA_HOME"] = join(root, "data");
  process.env["XDG_CACHE_HOME"] = join(root, "cache");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const path = rolePath(dataDirectory(process.env, root), workspace);
  return { root, workspace, path };
}
function edit(revision = 1) {
  return {
    operationId: "one",
    expectedInstanceId: "call",
    expectedGeneration: 1,
    expectedRoleRevision: revision,
    voice: "maple",
    apply: "next-session" as const,
  };
}
const empty: RoleBundle = { settings: {}, hasRole: false, files: [] };

test("ejection captures complete role contents; later calls and preflights ignore deleted source files", async () => {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(join(source, "skills", "sample"), { recursive: true });
  writeFileSync(join(source, "APPEND_SYSTEM_PROMPT.md"), "hello\n雪\n");
  writeFileSync(join(source, "VOICE_AGENT_SYSTEM_PROMPT.md"), "");
  writeFileSync(join(source, "skills/sample/SKILL.md"), "skill instructions");
  writeFileSync(join(source, "skills/sample/run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    join(source, "mcp.json"),
    JSON.stringify({ mcpServers: { sample: { command: "sample" } } }),
  );
  const configPath = join(f.root, "settings.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      role: source,
      voice: { name: "cove", extra: { includeStartupContext: null } },
      orchestrator: { model: "work-model" },
    }),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runRoleCommand(["eject", "--workspace", f.workspace, "--config", configPath]);
    const original = readRole(f.path);
    expect(original.files).toHaveLength(5);
    expect(original.settings).not.toHaveProperty("role");
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    rmSync(source, { recursive: true });
    writeFileSync(configPath, "invalid JSON, no longer live");
    const parsed = parseArgs(["--workspace", f.workspace, "--config", configPath]);
    const config = await loadLaunchConfig(parsed);
    const snapshot = await prepareRuntime(config);
    try {
      expect(snapshot.prompts.voicePrompt).toBe("");
      expect(snapshot.prompts.orchestratorDeveloperInstructions).toBe("hello\n雪\n");
      expect(readFileSync(join(snapshot.role!.skillsRoot!, "sample/run.sh"), "utf8")).toContain(
        "exit 0",
      );
      expect(threadParams(config, snapshot.prompts, "start", snapshot.role!)["model"]).toBe(
        "work-model",
      );
      expect(
        realtimeParams(config, snapshot.prompts, "t", "s", "offer")["includeStartupContext"],
      ).toBeNull();
      writeVoice(f.path, original.ref.id, edit());
      expect(config.voice.name).toBe("cove");
      const next = await loadLaunchConfig(parsed);
      expect(next.voice.name).toBe("maple");
      expect(next.roleDatabase!.snapshot.ref.revision).toBe(2);
      const nextSnapshot = await prepareRuntime(next);
      expect(next.configDir).not.toBe(config.configDir);
      nextSnapshot.dispose?.();
    } finally {
      snapshot.dispose?.();
    }
    await expect(
      loadLaunchConfig(parseArgs(["--workspace", f.workspace, "--voice", "sol"])),
    ).rejects.toThrow("cannot override");
  } finally {
    log.mockRestore();
  }
});

test("revision CAS, semantic retries, null clearing and exported copies remain independent", () => {
  const f = fixture();
  const first = createRole(f.path, { ...empty, settings: { voice: { name: "cove" } } });
  const second = writeVoice(f.path, first.id, edit());
  expect(second.revision).toBe(2);
  expect(writeVoice(f.path, first.id, { ...edit(), voice: "maple" })).toEqual(second);
  expect(() => writeVoice(f.path, first.id, { ...edit(), voice: "sol" })).toThrow(
    "different role edit",
  );
  expect(() => writeVoice(f.path, first.id, { ...edit(), operationId: "stale" })).toThrow(
    "Stale role revision",
  );
  const exported = join(f.root, "export.sqlite");
  const copied = createRole(exported, readRole(f.path), true);
  expect(copied.id).not.toBe(first.id);
  expect(copied.revision).toBe(1);
  const db = new Database(exported, { readonly: true });
  try {
    expect(db.query("SELECT count(*) AS n FROM receipts").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
  writeVoice(f.path, first.id, { ...edit(2), operationId: "clear", voice: null });
  expect(readRole(f.path).settings.voice).not.toHaveProperty("name");
  expect(readRole(exported).settings.voice?.name).toBe("maple");
  expect(() => createRole(f.path, empty)).toThrow("already has a role");
});

test("raw voice overrides fail without a revision or receipt; unsafe assets and future schemas fail closed", () => {
  const f = fixture();
  const ref = createRole(f.path, { ...empty, settings: { voice: { extra: { voice: null } } } });
  expect(() => writeVoice(f.path, ref.id, edit())).toThrow("masks");
  expect(readRole(f.path).ref.revision).toBe(1);
  expect(() =>
    materializeRole(join(f.root, "cache"), {
      ...empty,
      files: [{ path: "../outside", bytes: Buffer.from("x"), executable: false }],
    }),
  ).toThrow();
  expect(existsSync(join(f.root, "outside"))).toBe(false);
  const db = new Database(f.path);
  db.exec("PRAGMA user_version=99");
  db.close();
  expect(() => readRole(f.path)).toThrow("Unsupported role database schema");
  chmodSync(f.path, 0o644);
  expect(() => readRole(f.path)).toThrow("Unsafe private file");
});

test("imported links are captured, broken links and cycles fail, projections can be regenerated", () => {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source);
  const external = join(f.root, "external.md");
  writeFileSync(external, "original");
  symlinkSync(external, join(source, "APPEND_SYSTEM_PROMPT.md"));
  const files = captureFiles(source, true);
  writeFileSync(external, "changed");
  const bundle = { ...empty, hasRole: true, files };
  const projection = materializeRole(join(f.root, "cache"), bundle);
  expect(readFileSync(join(projection.directory, files[0]!.path), "utf8")).toBe("original");
  projection.remove();
  const next = materializeRole(join(f.root, "cache"), bundle);
  next.remove();
  symlinkSync(source, join(source, "cycle"));
  expect(() => captureFiles(source, true)).toThrow("cycle");
  rmSync(join(source, "cycle"));
  rmSync(external);
  expect(() => captureFiles(source, true)).toThrow();
});

test("impact planning combines boundaries and treats native passthrough conservatively", () => {
  expect(roleImpact(empty, { ...empty, settings: { voice: { name: "sol" } } })).toMatchObject({
    boundary: "voice",
    changes: [{ setting: "voice.name", impact: "voice" }],
  });
  expect(
    roleImpact(empty, {
      ...empty,
      settings: { voice: { name: "sol" }, orchestrator: { model: "new-model" } },
    }).boundary,
  ).toBe("runtime");
  expect(
    roleImpact(empty, { ...empty, settings: { voice: { extra: { futureNativeKey: true } } } })
      .boundary,
  ).toBe("runtime");
  expect(
    roleImpact(empty, { ...empty, settings: { orchestrator: { workspace: "/different" } } })
      .boundary,
  ).toBe("server");
  expect(roleImpact(empty, empty).boundary).toBe("none");
});

test("two processes cannot overwrite the initial workspace binding", async () => {
  const f = fixture();
  const program = `import {createRole} from ${JSON.stringify(new URL("../src/roles/store.ts", import.meta.url).pathname)}; try { createRole(process.argv[1], {settings:{},hasRole:false,files:[]}); } catch { process.exit(2); }`;
  const children = [
    Bun.spawn([process.execPath, "-e", program, f.path], { stdout: "pipe", stderr: "pipe" }),
    Bun.spawn([process.execPath, "-e", program, f.path], { stdout: "pipe", stderr: "pipe" }),
  ];
  expect((await Promise.all(children.map((child) => child.exited))).sort()).toEqual([0, 2]);
  expect(readRole(f.path).ref.revision).toBe(1);
});
