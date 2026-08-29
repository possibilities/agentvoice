/** Fixed AgentStart resource discovery for AgentVoice's resident Codex App
 * Server. The plugin is globally installed but its qualified skills are
 * persistently disabled; every AgentVoice thread name-enables the fixed set. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Environ } from "./paths.ts";

export const RESOURCES_ROOT_ENV = "AGENTSTART_RESOURCES_ROOT";

export interface SkillPolicyEntry {
  name: string;
  enabled: boolean;
}

export function resourcesRoot(env: Environ, home: string): string {
  const override = env[RESOURCES_ROOT_ENV];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(`${RESOURCES_ROOT_ENV} must be an absolute path: ${override}`);
    }
    return override;
  }
  return join(home, ".local", "share", "agentstart", "resources");
}

export function fleetSkillPolicy(
  env: Environ = process.env,
  home: string = homedir(),
): SkillPolicyEntry[] {
  const root = resourcesRoot(env, home);
  const namesPath = join(root, "managed-skills.txt");
  let names: string[];
  try {
    names = readFileSync(namesPath, "utf8")
      .split("\n")
      .filter((name) => name !== "")
      .sort();
  } catch {
    throw new Error(
      `AgentStart's fixed fleet resources are missing at ${root}; ` +
        `run ~/code/agentstart/scripts/install.sh --install`,
    );
  }
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error(`AgentStart's managed skill list is empty or invalid: ${namesPath}`);
  }
  return names.map((name) => ({ name: `agent:${name}`, enabled: true }));
}
