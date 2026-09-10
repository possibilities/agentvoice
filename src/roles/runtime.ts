import { homedir } from "node:os";
import type { ServerConfig } from "../core/config.ts";
import { cacheDirectory } from "../paths.ts";
import { materializeRole } from "./store.ts";

export function projectRole(config: ServerConfig): (() => void) | undefined {
  if (!config.roleDatabase) return undefined;
  const bundle = config.roleDatabase.snapshot;
  const projection = materializeRole(cacheDirectory(process.env, homedir()), bundle);
  config.configDir = projection.directory;
  config.role = bundle.hasRole ? projection.directory : undefined;
  return projection.remove;
}
