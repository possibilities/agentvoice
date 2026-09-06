/** Original launch provenance is reused by every disposable runtime. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ParsedArgs } from "../main.ts";
import { defaultConfigPath, expandTilde } from "../paths.ts";
import { ConfigError, cliToConfigValues, loadConfigFile, resolveConfig } from "./config.ts";

export async function loadLaunchConfig(parsed: ParsedArgs, launchCwd = process.cwd()) {
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
  const config = resolveConfig(cliValues, fileValues, process.env, home, {
    debug: parsed.debug,
    allowFullAccess: parsed.allowFullAccess,
    configDir: dirname(configPath),
    launchCwd,
  });
  try {
    if (!statSync(config.orchestrator.workspace).isDirectory()) throw new Error("not a directory");
    config.orchestrator.workspace = realpathSync(config.orchestrator.workspace);
  } catch (error) {
    throw new ConfigError(
      `Cannot use workspace ${config.orchestrator.workspace}: ${String(error)}`,
    );
  }
  return config;
}
