import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
  adoptRoleFiles,
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
    expect(snapshot.directoryRole).toBeUndefined();
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
      expect(nextSnapshot.directoryRole).toBeUndefined();
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

test("directory adoption is revision-fenced and preserves binding identity and settings losslessly", async () => {
  const f = fixture();
  const source = join(f.root, "manager-role");
  mkdirSync(join(source, "skills", "handoff"), { recursive: true });
  writeFileSync(join(source, "APPEND_SYSTEM_PROMPT.md"), "new direct-completion guidance\n");
  writeFileSync(join(source, "mcp.json"), "invalid JSON intentionally ignored by prompts-only");
  writeFileSync(join(source, "skills/handoff/SKILL.md"), "return directly to the parent\n");
  writeFileSync(join(source, "skills/handoff/run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  symlinkSync(source, join(source, "unrelated-cycle"));
  const initial: RoleBundle = {
    settings: {
      "allow-full-access": true,
      debug: true,
      "codex-config": ["features.multi_agent=true"],
      orchestrator: {
        model: "work-model",
        permissions: "danger-full-access",
        extra: { preserveNull: null },
      },
      voice: { name: "ember", extra: { preserveEmpty: "" } },
    },
    hasRole: true,
    files: [
      {
        path: "APPEND_SYSTEM_PROMPT.md",
        bytes: Buffer.from("old guidance\n"),
        executable: false,
      },
      {
        path: "skills/local/SKILL.md",
        bytes: Buffer.from("managed local skill\n"),
        executable: false,
      },
      {
        path: "mcp.json",
        bytes: Buffer.from(JSON.stringify({ mcpServers: { local: { command: "local-command" } } })),
        executable: false,
      },
    ],
  };
  const first = createRole(f.path, initial);
  const beforeDb = new Database(f.path, { readonly: true });
  const serializedBefore = beforeDb
    .query<{ settings: string }, []>("SELECT settings FROM revisions WHERE revision=1")
    .get()!.settings;
  beforeDb.close();

  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runRoleCommand([
      "adopt",
      "--workspace",
      f.workspace,
      "--role",
      source,
      "--expected-revision",
      "1",
      "--prompts-only",
      "--dry-run",
    ]);
    expect(readRole(f.path).ref).toEqual(first);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: first.id,
      previousRevision: 1,
      revision: 2,
      settingsPreserved: true,
      mode: "prompts",
      sourceAssets: 1,
      preservedAssets: 2,
      assets: 3,
      applied: false,
      dryRun: true,
      plan: { boundary: "runtime" },
    });

    await runRoleCommand([
      "adopt",
      "--workspace",
      f.workspace,
      "--role",
      source,
      "--expected-revision",
      "1",
      "--prompts-only",
    ]);
    const adopted = readRole(f.path);
    expect(adopted.ref).toEqual({ id: first.id, revision: 2 });
    expect(adopted.settings).toEqual(initial.settings);
    expect(adopted.hasRole).toBe(true);
    expect(adopted.files.map((file) => file.path)).toEqual([
      "APPEND_SYSTEM_PROMPT.md",
      "mcp.json",
      "skills/local/SKILL.md",
    ]);
    expect(
      Buffer.from(
        adopted.files.find((file) => file.path === "APPEND_SYSTEM_PROMPT.md")!.bytes,
      ).toString(),
    ).toBe("new direct-completion guidance\n");
    expect(
      Buffer.from(
        adopted.files.find((file) => file.path === "skills/local/SKILL.md")!.bytes,
      ).toString(),
    ).toBe("managed local skill\n");
    expect(
      Buffer.from(adopted.files.find((file) => file.path === "mcp.json")!.bytes).toString(),
    ).toContain("local-command");
    await runRoleCommand(["status", "--workspace", f.workspace]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: first.id,
      revision: 2,
      savedVoice: "ember",
      assets: 3,
      hasRole: true,
    });
    const afterDb = new Database(f.path, { readonly: true });
    try {
      const revisions = afterDb
        .query<{ revision: number; settings: string }, []>(
          "SELECT revision, settings FROM revisions ORDER BY revision",
        )
        .all();
      expect(revisions).toHaveLength(2);
      expect(revisions[0]!.settings).toBe(serializedBefore);
      expect(revisions[1]!.settings).toBe(serializedBefore);
    } finally {
      afterDb.close();
    }
    await expect(
      runRoleCommand([
        "adopt",
        "--workspace",
        f.workspace,
        "--role",
        source,
        "--expected-revision",
        "1",
      ]),
    ).rejects.toThrow("Stale role revision");
    expect(readRole(f.path).ref.revision).toBe(2);
  } finally {
    log.mockRestore();
  }
});

test("adoption rejects an invalid candidate without publishing a revision", async () => {
  const f = fixture();
  const source = join(f.root, "invalid-role");
  mkdirSync(source);
  writeFileSync(join(source, "mcp.json"), "not json");
  const first = createRole(f.path, empty);
  await expect(
    runRoleCommand([
      "adopt",
      "--workspace",
      f.workspace,
      "--role",
      source,
      "--expected-revision",
      "1",
    ]),
  ).rejects.toThrow("not valid JSON");
  expect(readRole(f.path).ref).toEqual(first);
});

test("full directory adoption updates supplied assets and a fresh runtime loads the revision", async () => {
  const f = fixture();
  const source = join(f.root, "full-role");
  mkdirSync(join(source, "skills", "source"), { recursive: true });
  writeFileSync(join(source, "APPEND_SYSTEM_PROMPT.md"), "full adoption guidance\n");
  writeFileSync(
    join(source, "mcp.json"),
    JSON.stringify({ mcpServers: { source: { command: "source-command" } } }),
  );
  writeFileSync(join(source, "skills/source/SKILL.md"), "source skill\n");
  const first = createRole(f.path, {
    settings: { orchestrator: { model: "preserved-model" } },
    hasRole: true,
    files: [
      { path: "skills/local/SKILL.md", bytes: Buffer.from("local skill\n"), executable: false },
    ],
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runRoleCommand([
      "adopt",
      "--workspace",
      f.workspace,
      "--role",
      source,
      "--expected-revision",
      "1",
    ]);
    const adopted = readRole(f.path);
    expect(adopted.ref).toEqual({ id: first.id, revision: 2 });
    expect(adopted.settings.orchestrator?.model).toBe("preserved-model");
    expect(adopted.files.map((file) => file.path)).toEqual([
      "APPEND_SYSTEM_PROMPT.md",
      "mcp.json",
      "skills/local/SKILL.md",
      "skills/source/SKILL.md",
    ]);
    const config = await loadLaunchConfig(parseArgs(["--workspace", f.workspace]));
    const runtime = await prepareRuntime(config);
    try {
      expect(runtime.prompts.orchestratorDeveloperInstructions).toBe("full adoption guidance\n");
      expect(runtime.role?.mcpServers?.["source"]?.["command"]).toBe("source-command");
      expect(readFileSync(join(runtime.role!.skillsRoot!, "local/SKILL.md"), "utf8")).toBe(
        "local skill\n",
      );
      expect(readFileSync(join(runtime.role!.skillsRoot!, "source/SKILL.md"), "utf8")).toBe(
        "source skill\n",
      );
    } finally {
      runtime.dispose?.();
    }
  } finally {
    log.mockRestore();
  }
});

test("store-level adoption rejects a concurrent stale writer", () => {
  const f = fixture();
  const first = createRole(f.path, empty);
  const files = [{ path: "APPEND_SYSTEM_PROMPT.md", bytes: Buffer.from("one"), executable: false }];
  expect(adoptRoleFiles(f.path, first.id, 1, files)).toEqual({ id: first.id, revision: 2 });
  expect(() => adoptRoleFiles(f.path, first.id, 1, files)).toThrow("Stale role revision");
  expect(readRole(f.path).ref.revision).toBe(2);
});

test("adoption rejects a conflicting stored asset without advancing the role head", () => {
  const f = fixture();
  const first = createRole(f.path, empty);
  const bytes = Buffer.from("expected");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const db = new Database(f.path);
  db.query("INSERT INTO assets VALUES (?, ?)").run(digest, Buffer.from("corrupt"));
  db.close();
  expect(() =>
    adoptRoleFiles(f.path, first.id, 1, [
      { path: "APPEND_SYSTEM_PROMPT.md", bytes, executable: false },
    ]),
  ).toThrow("does not match its content hash");
  expect(readRole(f.path).ref).toEqual(first);
});

test("adoption and dry-run refuse an exhausted immutable revision history", async () => {
  const f = fixture();
  const first = createRole(f.path, empty);
  const source = join(f.root, "role");
  mkdirSync(source);
  writeFileSync(join(source, "APPEND_SYSTEM_PROMPT.md"), "next");
  const db = new Database(f.path);
  const insert = db.query("INSERT INTO revisions VALUES (?, '{}', '[]', 0)");
  db.transaction(() => {
    for (let revision = 2; revision <= 4097; revision++) insert.run(revision);
    db.query("UPDATE role SET revision=4097").run();
  })();
  db.close();
  expect(() =>
    adoptRoleFiles(f.path, first.id, 4097, [
      { path: "APPEND_SYSTEM_PROMPT.md", bytes: Buffer.from("next"), executable: false },
    ]),
  ).toThrow("Role revision limit reached");
  await expect(
    runRoleCommand([
      "adopt",
      "--workspace",
      f.workspace,
      "--role",
      source,
      "--expected-revision",
      "4097",
      "--prompts-only",
      "--dry-run",
    ]),
  ).rejects.toThrow("Role revision limit reached");
  expect(readRole(f.path).ref).toEqual({ id: first.id, revision: 4097 });
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
  const files = [
    { path: "a", bytes: new Uint8Array([1]), executable: false },
    { path: "b", bytes: new Uint8Array([2]), executable: true },
  ];
  expect(
    roleImpact(
      { ...empty, hasRole: true, files },
      {
        ...empty,
        hasRole: true,
        files: [
          { path: "b", bytes: Buffer.from([2]), executable: true },
          { path: "a", bytes: Buffer.from([1]), executable: false },
        ],
      },
    ).boundary,
  ).toBe("none");
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
