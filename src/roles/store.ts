/** Authored role snapshots. Workspace bindings are paths, never portable database authority. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { PROMPT_FILES, parseJsonConfig } from "../core/config.ts";
import type { ConfigValues } from "../core/config-schema.ts";
import { ownedDirectory, ownedFile, safeAncestors } from "../private-files.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 4096;
const SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x4156524c;
export const roleRefSchema = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
export type RoleRef = z.infer<typeof roleRefSchema>;
const entrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          !path.includes("\\") &&
          !path.includes("\0") &&
          !path.startsWith("/") &&
          posix.normalize(path) === path &&
          !path.split("/").some((part) => part === ".." || part === "."),
      ),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.boolean(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
export interface RoleBundle {
  settings: ConfigValues;
  hasRole: boolean;
  files: Array<{ path: string; bytes: Uint8Array; executable: boolean }>;
}
export interface RoleSnapshot extends RoleBundle {
  ref: RoleRef;
  origin?: RoleRef;
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function rolePath(dataDir: string, workspace: string): string {
  return join(dataDir, "workspaces", hash(workspace), "role.sqlite");
}
export function canonicalWorkspace(path: string): string {
  const workspace = realpathSync(path);
  if (!statSync(workspace).isDirectory()) throw new Error("Workspace must be a directory");
  return workspace;
}
function settings(value: unknown): ConfigValues {
  const text = JSON.stringify(value);
  if (text.length > 1024 * 1024) throw new Error("Role settings exceed 1 MiB limit");
  const result = parseJsonConfig(text, "role database");
  if (
    result.role !== undefined ||
    result.codex !== undefined ||
    result.orchestrator?.workspace !== undefined
  )
    throw new Error("Role settings cannot contain local role, executable or workspace selectors");
  return result;
}
function manifest(bundle: RoleBundle): Entry[] {
  let total = 0;
  const paths = new Set<string>();
  if (bundle.files.length > MAX_FILES) throw new Error("Role exceeds file limit");
  return bundle.files
    .map((file) => {
      const entry = entrySchema.parse({
        path: file.path,
        hash: hash(file.bytes),
        executable: file.executable,
      });
      if (paths.has(entry.path)) throw new Error("Duplicate role asset path");
      paths.add(entry.path);
      total += file.bytes.byteLength;
      if (total > MAX_BYTES) throw new Error("Role exceeds 32 MiB asset limit");
      return entry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function open(path: string, readonly = true): Database {
  safeAncestors(dirname(path));
  if (!ownedFile(path))
    throw new Error("No workspace role database; use agentvoice role eject first");
  const db = new Database(path, { readonly, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF;");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    const app = db
      .query<{ application_id: number }, []>("PRAGMA application_id")
      .get()!.application_id;
    if (version !== SCHEMA_VERSION || app !== APPLICATION_ID)
      throw new Error("Unsupported role database schema");
    if (!readonly) db.exec("PRAGMA synchronous=FULL;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function hasRoleDatabase(path: string): boolean {
  safeAncestors(dirname(path));
  return ownedFile(path);
}

/** A complete publication or no binding at all; never replace an existing role. */
export function createRole(path: string, bundle: RoleBundle, exportFile = false): RoleRef {
  const values = settings(bundle.settings);
  const entries = manifest(bundle);
  const parent = exportFile ? dirname(path) : dirname(dirname(path));
  if (exportFile) safeAncestors(parent);
  else ownedDirectory(parent);
  if (lstatSync(exportFile ? path : dirname(path), { throwIfNoEntry: false }))
    throw new Error("Workspace already has a role; refusing replacement");
  const stageDir = exportFile ? undefined : join(parent, `.role-${randomUUID()}`);
  if (stageDir) mkdirSync(stageDir, { mode: 0o700 });
  const stage = stageDir
    ? join(stageDir, "role.sqlite")
    : join(parent, `.role-${randomUUID()}.sqlite`);
  const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  closeSync(fd);
  const ref = { id: randomUUID(), revision: 1 };
  const db = new Database(stage, { strict: true });
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};
      CREATE TABLE role (id TEXT NOT NULL, revision INTEGER NOT NULL, origin TEXT);
      CREATE TABLE revisions (revision INTEGER PRIMARY KEY, settings TEXT NOT NULL, manifest TEXT NOT NULL, has_role INTEGER NOT NULL);
      CREATE TABLE assets (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE receipts (instance TEXT NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(instance, operation));`);
    db.transaction(() => {
      const origin = (bundle as Partial<RoleSnapshot>).ref;
      db.query("INSERT INTO role VALUES (?, ?, ?)").run(
        ref.id,
        1,
        origin ? JSON.stringify(roleRefSchema.parse(origin)) : null,
      );
      db.query("INSERT INTO revisions VALUES (1, ?, ?, ?)").run(
        JSON.stringify(values),
        JSON.stringify(entries),
        Number(bundle.hasRole),
      );
      const insert = db.query("INSERT OR IGNORE INTO assets VALUES (?, ?)");
      for (const file of bundle.files) insert.run(hash(file.bytes), file.bytes);
    })();
    db.close();
    if (stageDir) {
      syncDirectory(stageDir);
      renameSync(stageDir, dirname(path));
    } else {
      linkSync(stage, path);
      unlinkSync(stage);
    }
    syncDirectory(parent);
    return ref;
  } finally {
    db.close();
    rmSync(stageDir ?? stage, { recursive: stageDir !== undefined, force: true });
  }
}
function read(db: Database): RoleSnapshot {
  const meta = db
    .query<{ id: string; revision: number }, []>("SELECT id, revision FROM role")
    .all();
  if (meta.length !== 1) throw new Error("Invalid role identity");
  const ref = roleRefSchema.parse(meta[0]);
  const row = db
    .query<{ settings: string; manifest: string; has_role: number }, [number]>(
      "SELECT settings, manifest, has_role FROM revisions WHERE revision=?",
    )
    .get(ref.revision);
  if (
    !row ||
    ![0, 1].includes(row.has_role) ||
    row.settings.length + row.manifest.length > MAX_BYTES
  )
    throw new Error("Invalid role revision");
  const entries = z.array(entrySchema).max(MAX_FILES).parse(JSON.parse(row.manifest));
  let total = 0;
  const files = entries.map((entry) => {
    const asset = db
      .query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM assets WHERE hash=?")
      .get(entry.hash);
    if (asset) total += asset.bytes.byteLength;
    if (!asset || total > MAX_BYTES || hash(asset.bytes) !== entry.hash)
      throw new Error("Invalid role asset");
    return { path: entry.path, executable: entry.executable, bytes: asset.bytes };
  });
  const origin = db.query<{ origin: string | null }, []>("SELECT origin FROM role").get()!.origin;
  const bundle = {
    ref,
    ...(origin ? { origin: roleRefSchema.parse(JSON.parse(origin)) } : {}),
    settings: settings(JSON.parse(row.settings)),
    hasRole: row.has_role === 1,
    files,
  };
  manifest(bundle);
  return bundle;
}
export function readRole(path: string): RoleSnapshot {
  const db = open(path);
  try {
    return db.transaction(() => read(db))();
  } finally {
    db.close();
  }
}
export function readRoleRef(path: string): RoleRef {
  return readRoleHead(path).ref;
}
export function readRoleHead(path: string): { ref: RoleRef; voice: string | null } {
  const db = open(path);
  try {
    const rows = db
      .query<{ id: string; revision: number; settings: string }, []>(
        "SELECT role.id, role.revision, revisions.settings FROM role JOIN revisions USING(revision)",
      )
      .all();
    if (rows.length !== 1) throw new Error("Invalid role identity or revision");
    const row = rows[0]!;
    return {
      ref: roleRefSchema.parse({ id: row.id, revision: row.revision }),
      voice: settings(JSON.parse(row.settings)).voice?.name ?? null,
    };
  } finally {
    db.close();
  }
}

/** Snapshot symlink targets as bytes; never retain a live filesystem dependency. */
export function captureFiles(directory: string, hasRole: boolean): RoleBundle["files"] {
  const files: RoleBundle["files"] = [];
  let total = 0;
  function walk(source: string, path: string, ancestors: Set<string>): void {
    const real = realpathSync(source);
    const info = statSync(real);
    if (info.isDirectory()) {
      if (ancestors.has(real) || ancestors.size > 64)
        throw new Error("Role asset directory cycle or depth limit");
      const next = new Set([...ancestors, real]);
      for (const name of readdirSync(real).sort())
        walk(join(real, name), path ? `${path}/${name}` : name, next);
    } else {
      total += info.size;
      if (!info.isFile() || total > MAX_BYTES || files.length >= MAX_FILES)
        throw new Error("Role asset type or size limit exceeded");
      files.push({ path, bytes: readFileSync(real), executable: (info.mode & 0o111) !== 0 });
    }
  }
  if (hasRole) walk(directory, "", new Set());
  else
    for (const name of Object.values(PROMPT_FILES)) {
      const source = join(directory, name);
      if (lstatSync(source, { throwIfNoEntry: false })) walk(source, name, new Set());
    }
  manifest({ settings: {}, hasRole, files });
  return files;
}

/** Per-load private projection: a live child never shares a mutable tree with its successor. */
export function materializeRole(
  cacheDir: string,
  bundle: RoleBundle,
): { directory: string; remove(): void } {
  manifest(bundle);
  const parent = join(cacheDir, "roles");
  ownedDirectory(parent);
  const directory = join(parent, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const path = join(directory, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.bytes, { flag: "wx", mode: file.executable ? 0o500 : 0o400 });
    }
    return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface VoiceEdit {
  operationId: string;
  expectedInstanceId: string;
  expectedGeneration: number;
  expectedRoleRevision: number;
  voice: string | null;
  apply: "voice" | "next-session";
}
export function writeVoice(path: string, roleId: string, request: VoiceEdit): RoleRef {
  const db = open(path, false);
  try {
    return db
      .transaction(() => {
        const fingerprint = JSON.stringify({
          operationId: request.operationId,
          expectedInstanceId: request.expectedInstanceId,
          expectedGeneration: request.expectedGeneration,
          expectedRoleRevision: request.expectedRoleRevision,
          voice: request.voice,
          apply: request.apply,
        });
        const prior = db
          .query<{ request: string; revision: number }, [string, string]>(
            "SELECT request, revision FROM receipts WHERE instance=? AND operation=?",
          )
          .get(request.expectedInstanceId, request.operationId);
        const meta = roleRefSchema.parse(db.query("SELECT id, revision FROM role").get());
        if (meta.id !== roleId) throw new Error("Role identity changed");
        if (prior) {
          if (prior.request !== fingerprint)
            throw new Error("Operation ID names a different role edit");
          return { id: meta.id, revision: prior.revision };
        }
        if (meta.revision !== request.expectedRoleRevision)
          throw new Error("Stale role revision; read status before editing");
        const row = db
          .query<{ settings: string; manifest: string; has_role: number }, [number]>(
            "SELECT settings, manifest, has_role FROM revisions WHERE revision=?",
          )
          .get(meta.revision)!;
        const values = settings(JSON.parse(row.settings));
        if (Object.hasOwn(values.voice?.extra ?? {}, "voice"))
          throw new Error("Raw voice.extra.voice masks the managed voice selection");
        values.voice = { ...values.voice };
        if (request.voice === null) delete values.voice.name;
        else values.voice.name = request.voice;
        const count = db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM receipts")
          .get()!.count;
        if (count >= 4096)
          throw new Error(
            "Role edit receipt limit reached; export/import into another workspace to compact",
          );
        const revision = meta.revision + 1;
        db.query("INSERT INTO revisions VALUES (?, ?, ?, ?)").run(
          revision,
          JSON.stringify(values),
          row.manifest,
          row.has_role,
        );
        db.query("UPDATE role SET revision=?").run(revision);
        db.query("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(
          request.expectedInstanceId,
          request.operationId,
          fingerprint,
          revision,
        );
        return { id: meta.id, revision };
      })
      .immediate();
  } finally {
    db.close();
  }
}
