/** Original launch provenance is reused by every disposable runtime. */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ParsedArgs } from "../main.ts";
import { dataDirectory, defaultConfigPath, expandTilde, stateDirectory } from "../paths.ts";
import { canonicalWorkspace, hasRoleDatabase, readRole, rolePath } from "../roles/store.ts";
import { currentWorkspace, workspaceBase } from "../workspace.ts";
import { ConfigError, cliToConfigValues, loadConfigFile, resolveConfig } from "./config.ts";

export async function loadLaunchConfig(parsed: ParsedArgs, launchCwd = process.cwd()) {
  // Call provenance pins this selector before worker preflight. Bound workspaces
  // must not read an old config file even when it is missing or now invalid.
  const explicit = parsed.values["workspace"];
  if (explicit !== undefined) {
    const workspace = canonicalWorkspace(resolve(launchCwd, expandTilde(explicit, homedir())));
    const bound = loadBoundConfig(parsed, workspace, launchCwd);
    if (bound) return bound;
  } else {
    const stateDir = stateDirectory(process.env, homedir());
    if (lstatSync(workspaceBase(stateDir), { throwIfNoEntry: false })) {
      const bound = loadBoundConfig(parsed, currentWorkspace(stateDir), launchCwd, true);
      if (bound) return bound;
    }
  }
  const source = await loadLaunchSource(parsed, launchCwd);
  return (
    loadBoundConfig(
      parsed,
      source.config.orchestrator.workspace,
      launchCwd,
      source.config.managedWorkspace,
    ) ?? source.config
  );
}

function loadBoundConfig(
  parsed: ParsedArgs,
  workspace: string,
  launchCwd: string,
  managedWorkspace = false,
) {
  const home = homedir();
  const path = rolePath(dataDirectory(process.env, home), workspace);
  if (!hasRoleDatabase(path)) return undefined;
  // Launch-only role overrides would otherwise mask persistent API changes.
  const ignored = Object.keys(parsed.values).filter(
    (key) => !["workspace", "codex", "resume"].includes(key),
  );
  if (ignored.length || parsed.codexConfig || parsed.allowFullAccess)
    throw new ConfigError(
      "This workspace owns a database role; role-setting launch flags cannot override it. Use role voice or the control API.",
    );
  const snapshot = readRole(path);
  const config = resolveConfig(
    {
      orchestrator: { workspace },
      ...(parsed.values["codex"] ? { codex: parsed.values["codex"] } : {}),
    },
    snapshot.settings,
    process.env,
    home,
    { launchCwd, debug: parsed.debug ? true : undefined },
  );
  return { ...config, roleDatabase: { path, snapshot }, managedWorkspace };
}

/** Explicit ejection reads source inputs once; ordinary bound launches never call it. */
export async function loadLaunchSource(parsed: ParsedArgs, launchCwd = process.cwd()) {
  const home = homedir();
  const configPath = parsed.configPath
    ? resolve(launchCwd, expandTilde(parsed.configPath, home))
    : defaultConfigPath(process.env, home);
  const {
    device: _device,
    "output-device": _outputDevice,
    resume: _resume,
    ...values
  } = parsed.values;
  const cliValues = cliToConfigValues(values);
  if (parsed.codexConfig) cliValues["codex-config"] = parsed.codexConfig;
  const fileValues = await loadConfigFile(configPath, parsed.configPath !== undefined);
  const managedWorkspace =
    cliValues.orchestrator?.workspace === undefined &&
    fileValues.orchestrator?.workspace === undefined;
  const config = resolveConfig(cliValues, fileValues, process.env, home, {
    debug: parsed.debug ? true : undefined,
    allowFullAccess: parsed.allowFullAccess,
    configDir: dirname(configPath),
    launchCwd,
    ...(managedWorkspace
      ? { defaultWorkspace: currentWorkspace(stateDirectory(process.env, home)) }
      : {}),
  });
  try {
    if (!statSync(config.orchestrator.workspace).isDirectory()) throw new Error("not a directory");
    config.orchestrator.workspace = realpathSync(config.orchestrator.workspace);
  } catch (error) {
    throw new ConfigError(
      `Cannot use workspace ${config.orchestrator.workspace}: ${String(error)}`,
    );
  }
  const settings = {
    ...fileValues,
    ...cliValues,
    orchestrator: { ...fileValues.orchestrator, ...cliValues.orchestrator },
    voice: { ...fileValues.voice, ...cliValues.voice },
    ...(config.codexConfig ? { "codex-config": config.codexConfig } : {}),
    ...(config.allowFullAccess ? { "allow-full-access": true } : {}),
    ...(config.debug ? { debug: true } : {}),
  };
  delete settings.role;
  delete settings.codex;
  delete settings.orchestrator.workspace;
  return { config: { ...config, managedWorkspace }, settings };
}
