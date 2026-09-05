/** XDG configuration and private application state; Codex owns conversation history. */
import { isAbsolute, join } from "node:path";

export type Environ = Record<string, string | undefined>;

export function stateDirectory(env: Environ, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "agentvoice");
}

export function defaultConfigPath(env: Environ, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "agentvoice", "server.json");
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
