/** Bounded content observations, never a native-consumption or hot-reload guarantee. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { PROMPT_FILES } from "./config.ts";
import { ROLE_MCP_FILE, ROLE_PROMPT_FILES, ROLE_SKILLS_DIR } from "./role.ts";

const pathSchema = z.string().min(1).refine(isAbsolute);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const roleContentSchema = z
  .object({
    format: z.literal("agentvoice-role-content-v1"),
    content: digestSchema,
    prompts: digestSchema,
    mcp: digestSchema,
    skills: digestSchema,
  })
  .strict();
export type RoleContent = z.infer<typeof roleContentSchema>;
export const directoryRoleInfoSchema = z
  .object({
    path: pathSchema,
    digests: roleContentSchema,
  })
  .strict();
export type DirectoryRoleInfo = z.infer<typeof directoryRoleInfoSchema>;
export const directoryRoleStatusSchema = z
  .object({
    source: z.object({ kind: z.literal("directory"), path: pathSchema }).strict(),
    loaded: z
      .object({ generation: z.number().int().positive(), digests: roleContentSchema })
      .strict(),
    desired: z.object({ digests: roleContentSchema }).strict().optional(),
    stale: z.boolean().nullable(),
    error: z
      .literal("Directory role content is unavailable or exceeds observation limits")
      .optional(),
  })
  .strict();
export type DirectoryRoleStatus = z.infer<typeof directoryRoleStatusSchema>;
export const workspaceRoleSourceStatusSchema = z
  .object({
    source: z.object({ kind: z.literal("directory"), path: pathSchema }).strict(),
    loaded: z
      .object({
        generation: z.number().int().positive(),
        revision: z.number().int().positive(),
        digests: roleContentSchema,
      })
      .strict(),
    current: z.object({ digests: roleContentSchema }).strict().optional(),
    stale: z.boolean().nullable(),
    error: z
      .literal("Configured role source is unavailable or exceeds observation limits")
      .optional(),
  })
  .strict();
export type WorkspaceRoleSourceStatus = z.infer<typeof workspaceRoleSourceStatusSchema>;

type Entry = { path: string; kind: "file" | "directory"; hash?: string; executable?: boolean };
function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function finish(entries: Entry[], omitEmptySkillDirectories = false): RoleContent {
  if (omitEmptySkillDirectories) {
    const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    entries = entries.filter(
      (entry) => entry.kind === "file" || files.some((path) => path.startsWith(`${entry.path}/`)),
    );
  }
  entries = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = (selected: Entry[]) =>
    hash(JSON.stringify(["agentvoice-role-content-v1", selected]));
  return {
    format: "agentvoice-role-content-v1",
    content: digest(entries),
    prompts: digest(
      entries.filter(
        (entry) =>
          entry.path !== ROLE_MCP_FILE &&
          !entry.path.startsWith(`${ROLE_SKILLS_DIR}/`) &&
          entry.path !== ROLE_SKILLS_DIR,
      ),
    ),
    mcp: digest(entries.filter((entry) => entry.path === ROLE_MCP_FILE)),
    skills: digest(
      entries.filter(
        (entry) => entry.path === ROLE_SKILLS_DIR || entry.path.startsWith(`${ROLE_SKILLS_DIR}/`),
      ),
    ),
  };
}

/** Prompt and MCP readers supply the exact buffers they decode, avoiding a second read. */
export class RoleContentCapture {
  private readonly entries: Entry[] = [];
  private bytes = 0;
  constructor(readonly directory: string) {}

  file = (path: string, bytes: Uint8Array, executable?: boolean): void => {
    this.bytes += bytes.byteLength;
    if (this.bytes > 32 * 1024 * 1024 || this.entries.length >= 4096)
      throw new Error("Role content observation limit exceeded");
    this.entries.push({
      path: relative(this.directory, path),
      kind: "file",
      hash: hash(bytes),
      ...(executable === undefined ? {} : { executable }),
    });
  };

  skills(): void {
    const walk = (path: string, ancestors: Set<string>): void => {
      const real = realpathSync(path);
      const info = statSync(real);
      if (info.isDirectory()) {
        if (ancestors.has(real) || ancestors.size >= 64 || this.entries.length >= 4096)
          throw new Error("Role content directory cycle or limit exceeded");
        this.entries.push({ path: relative(this.directory, path), kind: "directory" });
        const next = new Set([...ancestors, real]);
        for (const name of readdirSync(real).sort()) walk(join(path, name), next);
      } else {
        if (!info.isFile() || info.size + this.bytes > 32 * 1024 * 1024)
          throw new Error("Role content type or size limit exceeded");
        this.file(path, readFileSync(real), (info.mode & 0o111) !== 0);
      }
    };
    const path = join(this.directory, ROLE_SKILLS_DIR);
    if (lstatSync(path, { throwIfNoEntry: false })) {
      if (!statSync(path).isDirectory()) return; // Matches role skills-root discovery.
      walk(path, new Set());
    }
  }

  finish(options: { omitEmptySkillDirectories?: boolean } = {}): RoleContent {
    return finish(this.entries, options.omitEmptySkillDirectories);
  }
}

/** Reconstruct the effective role inputs from an immutable database asset bundle. */
export function roleContentFromFiles(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array; executable: boolean }>,
): RoleContent {
  const promptNames = new Set<string>([
    ...Object.values(ROLE_PROMPT_FILES),
    ...Object.values(PROMPT_FILES),
  ]);
  const entries: Entry[] = [];
  const directories = new Set<string>();
  for (const file of files) {
    const relevant =
      promptNames.has(file.path) ||
      file.path === ROLE_MCP_FILE ||
      file.path.startsWith(`${ROLE_SKILLS_DIR}/`);
    if (!relevant) continue;
    if (file.path.startsWith(`${ROLE_SKILLS_DIR}/`)) {
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++)
        directories.add(parts.slice(0, index).join("/"));
    }
    entries.push({
      path: file.path,
      kind: "file",
      hash: hash(file.bytes),
      ...(file.path.startsWith(`${ROLE_SKILLS_DIR}/`) ? { executable: file.executable } : {}),
    });
  }
  for (const path of directories) entries.push({ path, kind: "directory" });
  return finish(entries);
}

/** Read-only source observation. Deliberately never discovers config, DBs or credentials. */
export function readDirectoryRoleContent(directory: string): RoleContent {
  return readRoleContent(directory);
}

function readAdoptableRoleContent(directory: string): RoleContent {
  return readRoleContent(directory, true);
}

function readRoleContent(directory: string, omitEmptySkillDirectories = false): RoleContent {
  if (!statSync(directory).isDirectory()) throw new Error("Role directory unavailable");
  const capture = new RoleContentCapture(directory);
  for (const name of [
    ...Object.values(ROLE_PROMPT_FILES),
    ...Object.values(PROMPT_FILES),
    ROLE_MCP_FILE,
  ]) {
    const path = join(directory, name);
    if (!lstatSync(path, { throwIfNoEntry: false })) continue;
    const info = statSync(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error("Role content type or size limit exceeded");
    capture.file(path, readFileSync(path));
  }
  capture.skills();
  return capture.finish({ omitEmptySkillDirectories });
}

export function directoryRoleStatus(
  info: DirectoryRoleInfo,
  generation: number,
): DirectoryRoleStatus {
  const status: DirectoryRoleStatus = {
    source: { kind: "directory", path: info.path },
    loaded: { generation, digests: structuredClone(info.digests) },
    stale: null,
  };
  try {
    const digests = readDirectoryRoleContent(info.path);
    status.desired = { digests };
    status.stale = digests.content !== info.digests.content;
  } catch {
    status.error = "Directory role content is unavailable or exceeds observation limits";
  }
  return status;
}

/** Compare a loaded immutable snapshot with a configured explicit adoption source. */
export function workspaceRoleSourceStatus(
  info: DirectoryRoleInfo,
  generation: number,
  revision: number,
): WorkspaceRoleSourceStatus {
  const status: WorkspaceRoleSourceStatus = {
    source: { kind: "directory", path: info.path },
    loaded: { generation, revision, digests: structuredClone(info.digests) },
    stale: null,
  };
  try {
    const digests = readAdoptableRoleContent(info.path);
    status.current = { digests };
    status.stale = digests.content !== info.digests.content;
  } catch {
    status.error = "Configured role source is unavailable or exceeds observation limits";
  }
  return status;
}
