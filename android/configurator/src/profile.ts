import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseProfile } from "./protocol.ts";

export async function saveProfile(path: string, text: string) {
  parseProfile(text);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && !existing.isFile()) throw Error("Save destination must be a regular file.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
}
