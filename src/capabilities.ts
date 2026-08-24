/**
 * AgentStart capability-pack discovery for AgentVoice's standalone Codex
 * app-server. AgentVoice owns no skill copies: it registers the default
 * common pack's canonical skill root on every app-server attachment.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Environ } from "./paths.ts";

export const CAPABILITIES_ROOT_ENV = "AGENTSTART_CAPABILITIES_ROOT";

export function capabilitiesRoot(env: Environ, home: string): string {
  const override = env[CAPABILITIES_ROOT_ENV];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(`${CAPABILITIES_ROOT_ENV} must be an absolute path: ${override}`);
    }
    return override;
  }
  return join(home, ".local", "share", "agentstart", "capabilities");
}

export function commonSkillsRoot(env: Environ = process.env, home: string = homedir()): string {
  const root = join(capabilitiesRoot(env, home), "packs", "common", "skills");
  try {
    if (statSync(root).isDirectory()) return root;
  } catch {
    // The actionable installation error below owns absent and unreadable roots.
  }
  throw new Error(
    `AgentStart's common capability pack is missing at ${root}; ` +
      `run ~/code/agentstart/scripts/install.sh --install`,
  );
}

/** One `skills.config` rule, as codex's thread `config` map accepts it. */
export interface SkillPolicyEntry {
  name: string;
  enabled: boolean;
}

/**
 * Codex qualifies a plugin's skills as `<plugin>:<skill>`. AgentStart projects
 * the same common pack a second time through its `agent` compatibility plugin,
 * for desktop clients that do not open threads through a capability-aware
 * caller. That plugin is enabled persistently in `config.toml` and a session
 * cannot turn it off, so a thread that registers the pack root sees every
 * fleet skill twice — once bare, once as `agent:<skill>` — unless the aliases
 * are disabled by name. The duplicates are not free: codex caps the skills
 * catalogue at a share of the context window and shortens every description
 * in the thread to fit, so the aliases cost the whole catalogue its detail.
 *
 * Absent projection means nothing to suppress, which is the ordinary shape on
 * a machine whose AgentStart install predates the compatibility plugin.
 */
export function compatibilityAliasPolicy(
  env: Environ = process.env,
  home: string = homedir(),
): SkillPolicyEntry[] {
  const root = join(
    capabilitiesRoot(env, home),
    "compatibility",
    "codex-marketplace",
    "plugins",
    "agent",
    "skills",
  );
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name: `agent:${name}`, enabled: false }));
}

export interface CapabilityAttachment {
  request(method: string, params: unknown): Promise<unknown>;
}

/** Register common before invoking the thread start/resume operation. */
export async function withCommonSkills<T>(
  attachment: CapabilityAttachment,
  openThread: () => Promise<T>,
  root = commonSkillsRoot(),
): Promise<T> {
  await attachment.request("skills/extraRoots/set", { extraRoots: [root] });
  return openThread();
}
