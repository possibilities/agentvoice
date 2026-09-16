import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const FILE_PICKER_MAX_ENTRIES = 200;
export const FILE_PICKER_MAX_SCANNED_ENTRIES = 1_000;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_QUERY_BYTES = 256;

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const boundedText = (maxBytes: number) =>
  z.string().refine((value) => !hasControl(value) && Buffer.byteLength(value, "utf8") <= maxBytes);

export const filePickerRequestSchema = z
  .object({
    path: boundedText(MAX_PATH_BYTES)
      .refine((value) => isAbsolute(value))
      .optional(),
    query: boundedText(MAX_QUERY_BYTES).optional(),
  })
  .strict();

export type FilePickerRequest = z.infer<typeof filePickerRequestSchema>;
export type FilePickerEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};
export type FilePickerListing = {
  path: string;
  parent: string | null;
  entries: FilePickerEntry[];
  truncated: boolean;
};

export class FilePickerAccessError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function contained(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
}

function hiddenBelow(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest.split(sep).some((part) => part.startsWith("."));
}

function accessError(error: unknown): FilePickerAccessError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new FilePickerAccessError(404, "Folder was not found.");
  if (code === "EACCES" || code === "EPERM")
    return new FilePickerAccessError(403, "Folder cannot be opened.");
  return new FilePickerAccessError(400, "Folder could not be listed.");
}

/** Read-only metadata browser rooted at the operator's home directory. */
export class FilePicker {
  constructor(private readonly home = homedir()) {}

  async list(request: FilePickerRequest): Promise<FilePickerListing> {
    let root: string;
    try {
      root = await realpath(resolve(this.home));
    } catch (error) {
      throw accessError(error);
    }
    const requested = resolve(request.path ?? root);
    if (!contained(root, requested))
      throw new FilePickerAccessError(403, "The file picker only browses the home folder.");
    if (hiddenBelow(root, requested))
      throw new FilePickerAccessError(403, "Hidden folders are not available in the file picker.");

    let current: string;
    try {
      const info = await lstat(requested);
      current = await realpath(requested);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        current !== requested ||
        !contained(root, current) ||
        hiddenBelow(root, current)
      )
        throw new FilePickerAccessError(403, "Folder cannot be opened.");
    } catch (error) {
      if (error instanceof FilePickerAccessError) throw error;
      throw accessError(error);
    }

    const query = request.query?.toLocaleLowerCase();
    const entries: FilePickerEntry[] = [];
    let truncated = false;
    try {
      const directory = await opendir(current);
      let scanned = 0;
      for await (const entry of directory) {
        scanned++;
        if (scanned > FILE_PICKER_MAX_SCANNED_ENTRIES) {
          truncated = true;
          break;
        }
        if (
          entry.name.startsWith(".") ||
          hasControl(entry.name) ||
          Buffer.byteLength(entry.name, "utf8") > 255 ||
          (query && !entry.name.toLocaleLowerCase().includes(query)) ||
          (!entry.isFile() && !entry.isDirectory())
        )
          continue;
        if (entries.length === FILE_PICKER_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({
          name: entry.name,
          path: join(current, entry.name),
          kind: entry.isDirectory() ? "directory" : "file",
        });
      }
    } catch (error) {
      throw accessError(error);
    }
    entries.sort(
      (left, right) =>
        (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
        left.name.localeCompare(right.name),
    );
    return {
      path: current,
      parent: current === root ? null : dirname(current),
      entries,
      truncated,
    };
  }
}
