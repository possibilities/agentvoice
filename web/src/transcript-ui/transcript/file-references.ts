export type FilePickerEntry = { name: string; path: string; kind: "file" | "directory" };
export type FilePickerListing = {
  path: string;
  parent: string | null;
  entries: FilePickerEntry[];
  truncated: boolean;
};
export type ListReferenceFiles = (
  request: { path?: string; query?: string },
  signal: AbortSignal,
) => Promise<FilePickerListing>;

// Native collaboration identifies workers with these paths. They are not host file references.
const canonicalWorkerPath = /^\/root(?:\/[a-z0-9_]+)+$/u;

export function isCanonicalWorkerPath(value: string): boolean {
  return canonicalWorkerPath.test(value.trim());
}

/** A filename or browser-relative path is never evidence of an absolute host path. */
export function absoluteReferencePath(value: string): string | null {
  let path = value.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
    path = path.slice(1, -1);
  if (path.startsWith("file:")) {
    try {
      const url = new URL(path);
      if (
        url.protocol !== "file:" ||
        (url.hostname && url.hostname !== "localhost") ||
        url.search ||
        url.hash
      )
        return null;
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  return path.startsWith("/") &&
    !path.startsWith("//") &&
    !Array.from(path).some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    ) &&
    path.length <= 4096
    ? path
    : null;
}

export function transferredReferencePaths(transfer: {
  getData(type: string): string;
  files: ArrayLike<{ name: string; path?: string }>;
}): string[] {
  const uriList = transfer.getData("text/uri-list");
  const text = uriList || transfer.getData("text/plain");
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !(uriList && line.startsWith("#")));
  if (lines.length) {
    const paths = lines.map((line) =>
      isCanonicalWorkerPath(line) ? null : absoluteReferencePath(line),
    );
    if (paths.every((path): path is string => path !== null)) return [...new Set(paths)];
  }
  const files = Array.from(transfer.files);
  const paths = files.map((file) => absoluteReferencePath(file.path ?? ""));
  return paths.length && paths.every((path): path is string => path !== null)
    ? [...new Set(paths)]
    : [];
}

export function insertFileReferences(
  text: string,
  paths: readonly string[],
  start: number,
  end: number,
) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const references = paths.map((path) => `@${path}`).join("\n");
  const inserted = `${before && !/\s$/u.test(before) ? " " : ""}${references}${after && !/^\s/u.test(after) ? " " : ""}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
