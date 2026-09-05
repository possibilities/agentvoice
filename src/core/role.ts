/**
 * A role is a directory that changes what an agent can do for one launch:
 * skills, MCP servers, and prompt replacements or appends. The format is
 * shared with the agentroles CLI, which delivers it to Claude Code and the
 * Codex CLI by argv; AgentVoice reads it natively because only this process
 * can register skill roots with its owned child. Prompt files in a role are
 * read by config.ts; this module owns resolution, MCP translation and skills.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type Environ, expandTilde } from "../paths.ts";
import { ConfigError } from "./config-error.ts";

/** Names must survive as unquoted Codex config key segments (no dots) and shell words. */
export const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const ROLE_MCP_FILE = "mcp.json";
export const ROLE_SKILLS_DIR = "skills";

/** General role prompts, the same files agentroles delivers to Claude Code and Codex. */
export const ROLE_PROMPT_FILES = {
  orchestratorBaseInstructions: "SYSTEM_PROMPT.md",
  orchestratorDeveloperInstructions: "APPEND_SYSTEM_PROMPT.md",
} as const;

export interface RoleAssets {
  dir: string;
  /** Codex-shaped mcp_servers entries translated from mcp.json; absent without the file. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Absolute skills root, present when <role>/skills is a directory. */
  skillsRoot?: string;
}

export function rolesHome(env: Environ, home: string): string {
  const configured = env["AGENTROLES_HOME"];
  return configured ? expandTilde(configured, home) : join(home, ".config", "agentroles");
}

/** A path when it looks like one; otherwise a name under the roles home. */
export function resolveRolePath(
  spec: string,
  env: Environ,
  home: string,
  launchCwd: string,
): string {
  const trimmed = spec.trim();
  if (!trimmed) throw new ConfigError("role must be a non-empty name or directory path");
  if (trimmed.includes("/") || trimmed.startsWith(".") || trimmed.startsWith("~"))
    return resolve(launchCwd, expandTilde(trimmed, home));
  if (!ROLE_NAME_PATTERN.test(trimmed))
    throw new ConfigError(
      `role "${trimmed}" is neither a directory path nor a name (letters, digits, "_" and "-")`,
    );
  return join(rolesHome(env, home), trimmed);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * mcp.json uses Claude Code's `.mcp.json` shape. Codex's transport enum rejects
 * unknown keys, so the Claude-only ones are translated rather than forwarded;
 * every other key passes through for native validation.
 */
export function translateMcpServers(
  document: unknown,
  source: string,
): Record<string, Record<string, unknown>> {
  if (!record(document) || !record(document["mcpServers"]))
    throw new ConfigError(`${source}: expected {"mcpServers": {...}}`);
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(document["mcpServers"])) {
    if (!ROLE_NAME_PATTERN.test(name))
      throw new ConfigError(`${source}: MCP server name "${name}" must match ${ROLE_NAME_PATTERN}`);
    if (!record(entry)) throw new ConfigError(`${source}: mcpServers.${name} must be an object`);
    const { type, headers, ...rest } = entry;
    if (type !== undefined && type !== "stdio" && type !== "http")
      throw new ConfigError(
        `${source}: mcpServers.${name}.type "${String(type)}" is not supported by Codex (stdio or http)`,
      );
    const hasCommand = typeof rest["command"] === "string";
    const hasUrl = typeof rest["url"] === "string";
    if (hasCommand === hasUrl)
      throw new ConfigError(`${source}: mcpServers.${name} needs exactly one of command or url`);
    const server: Record<string, unknown> = { ...rest };
    if (headers !== undefined) {
      if (!record(headers))
        throw new ConfigError(`${source}: mcpServers.${name}.headers must be an object`);
      server["http_headers"] = headers;
    }
    servers[name] = server;
  }
  return servers;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Loads the non-prompt assets; a missing role directory fails before native startup. */
export async function readRoleAssets(dir: string): Promise<RoleAssets> {
  if (!isAbsolute(dir)) throw new ConfigError(`role directory must be absolute: ${dir}`);
  if (!(await directoryExists(dir)))
    throw new ConfigError(
      `role directory not found: ${dir} (name a directory under $AGENTROLES_HOME or ~/.config/agentroles, or give a path)`,
    );
  const assets: RoleAssets = { dir };
  const mcpPath = join(dir, ROLE_MCP_FILE);
  let mcpText: string | undefined;
  try {
    mcpText = await readFile(mcpPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ConfigError(`${ROLE_MCP_FILE}: cannot read ${mcpPath}: ${String(error)}`);
  }
  if (mcpText !== undefined) {
    let document: unknown;
    try {
      document = JSON.parse(mcpText);
    } catch (error) {
      throw new ConfigError(`${mcpPath}: not valid JSON: ${String(error)}`);
    }
    assets.mcpServers = translateMcpServers(document, mcpPath);
  }
  const skillsRoot = join(dir, ROLE_SKILLS_DIR);
  if (await directoryExists(skillsRoot)) assets.skillsRoot = skillsRoot;
  return assets;
}
