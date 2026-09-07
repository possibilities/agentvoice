import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ownedDirectory, safeAncestors } from "./private-files.ts";

export function workspaceBase(stateDir: string): string {
  return join(stateDir, "default", "workspaces");
}

// Names, rather than mutable directory mtimes, define generation order.
const generationName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}$/;

export function currentWorkspace(stateDir: string, create = true): string {
  const base = workspaceBase(stateDir);
  if (!create && !lstatSync(base, { throwIfNoEntry: false }))
    throw new Error("No default workspace exists yet; start a voice call or pass --workspace");
  ownedDirectory(stateDir);
  ownedDirectory(join(stateDir, "default"));
  ownedDirectory(base);
  const newest = () =>
    readdirSync(base, { withFileTypes: true })
      .filter((entry) => generationName.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
  let name = newest();
  if (!name && !create)
    throw new Error("No default workspace exists yet; start a voice call or pass --workspace");
  if (!name) {
    // All concurrent initializers publish the same initial directory atomically.
    // The fixed UUID is only for the initial generation; later names may use any UUID.
    name = `${statSync(base).birthtime.toISOString().replaceAll(":", "-")}-00000000-0000-0000-0000-000000000000`;
    try {
      mkdirSync(join(base, name), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    name = newest()!;
  }
  const path = join(base, name);
  safeAncestors(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`Workspace directory must be owned by this user: ${path}`);
  return realpathSync(path);
}
