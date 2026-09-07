import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/** Refuse writable/redirected ancestors before creating application-owned state. */
export function safeAncestors(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path === "/")
    throw new Error(`Expected an absolute normalized path: ${path}`);
  let current = "";
  for (const part of path.slice(1).split("/")) {
    current += `/${part}`;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (
      process.platform === "darwin" &&
      (current === "/tmp" || current === "/var") &&
      stat.isSymbolicLink() &&
      stat.uid === 0 &&
      realpathSync(current) === `/private${current}`
    )
      continue;
    if (
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
    )
      throw new Error(`Unsafe directory: ${current}`);
  }
}

export function ownedDirectory(path: string, mode = 0o700): void {
  safeAncestors(path);
  mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== mode)
    throw new Error(`Directory must be owned by this user with mode ${mode.toString(8)}: ${path}`);
}

export function ownedFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error(`Unsafe private file: ${path}`);
  return true;
}
