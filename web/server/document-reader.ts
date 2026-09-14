import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { z } from "zod";
import { safeAncestors } from "../../src/private-files.ts";

function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const documentRequestSchema = z
  .object({
    href: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !hasControlCharacters(value)),
    base: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !hasControlCharacters(value))
      .optional(),
  })
  .strict();

export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export type LoadedDocument = { title: string; path: string; content: string };

export type DocumentViewContext = {
  viewId: string;
  workspace: string;
  assistantMarkdown: readonly string[];
  current(): boolean;
};

export type DocumentContextSource = {
  documentContext(): Promise<DocumentViewContext | undefined>;
};

type Grant = { root: string; links: Set<string> };
type ParsedTarget = { kind: "absolute" | "relative"; path: string };

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const BUFFER_BYTES = 64 * 1024;
const MAX_DOCUMENT_GRANTS = 128;
const MAX_DOCUMENT_LINKS = 512;
const MAX_TRANSCRIPT_LINKS = 4096;

export class DocumentAccessError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "DocumentAccessError";
  }
}

function denied() {
  return new DocumentAccessError(403, "Document link is not available.");
}

function unsupported() {
  return new DocumentAccessError(400, "Unsupported document link.");
}

/** Extract inline Markdown link destinations while refusing links shown only as code. */
export function markdownLinks(source: string, limit = MAX_DOCUMENT_LINKS) {
  type Node = {
    type: string;
    url?: unknown;
    identifier?: unknown;
    children?: readonly Node[];
  };
  const tree = fromMarkdown(source) as Node;
  const definitions = new Map<string, string>();
  const links = new Set<string>();

  const walk = (node: Node, collectLinks: boolean) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string" &&
      definitions.size < limit &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, normalizeUri(node.url));
    if (collectLinks && links.size < limit) {
      if (node.type === "link" && typeof node.url === "string") links.add(normalizeUri(node.url));
      if (node.type === "linkReference" && typeof node.identifier === "string") {
        const resolved = definitions.get(node.identifier);
        if (resolved) links.add(resolved);
      }
    }
    for (const child of node.children ?? []) walk(child, collectLinks);
  };
  // Definitions may occur after their references.
  walk(tree, false);
  walk(tree, true);
  return links;
}

function transcriptFingerprint(markdown: readonly string[]) {
  const hash = createHash("sha256");
  for (const source of markdown)
    hash
      .update(String(Buffer.byteLength(source)))
      .update(":")
      .update(source);
  return hash.digest("hex");
}

function contained(root: string, path: string) {
  const child = relative(root, path);
  return child !== "" && !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child);
}

function hiddenBelow(root: string, path: string) {
  return relative(root, path)
    .split(sep)
    .some((part) => part.startsWith("."));
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw unsupported();
  }
}

function parseTarget(href: string, home: string): ParsedTarget {
  let target = href;
  const fragment = target.indexOf("#");
  if (fragment >= 0) target = target.slice(0, fragment);
  target = target.replace(/(\.(?:md|markdown)):\d+(?::\d+)?$/iu, "$1");
  if (!target || target.includes("?")) throw unsupported();

  if (/^file:/iu.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw unsupported();
    }
    if ((url.hostname && url.hostname !== "localhost") || url.search) throw unsupported();
    try {
      return { kind: "absolute", path: fileURLToPath(url) };
    } catch {
      throw unsupported();
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//")) throw unsupported();

  target = decodePath(target);
  if (hasControlCharacters(target)) throw unsupported();
  if (target.startsWith("~/")) return { kind: "absolute", path: resolve(home, target.slice(2)) };
  return isAbsolute(target)
    ? { kind: "absolute", path: resolve(target) }
    : { kind: "relative", path: target };
}

function canonicalRoot(path: string) {
  const normalized = resolve(path);
  try {
    safeAncestors(normalized);
    const info = lstatSync(normalized);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(normalized) !== normalized)
      return;
    return normalized;
  } catch {
    return;
  }
}

function permittedRoot(candidate: string, workspace: string, home: string) {
  for (const path of [workspace, join(home, "wiki"), join(home, "obsidian", "work")]) {
    const root = canonicalRoot(path);
    if (root && contained(root, candidate)) return root;
  }

  const code = resolve(home, "code");
  const fromCode = relative(code, candidate);
  if (fromCode.startsWith(`..${sep}`) || fromCode === ".." || isAbsolute(fromCode)) return;
  const project = fromCode.split(sep)[0];
  if (!project || project.startsWith(".")) return;
  const root = canonicalRoot(join(code, project));
  if (root && contained(root, candidate)) return root;
}

function readMarkdown(path: string, root: string, maxBytes: number) {
  if (!contained(root, path) || hiddenBelow(root, path)) throw denied();
  const extension = extname(path).toLowerCase();
  if (extension !== ".md" && extension !== ".markdown")
    throw new DocumentAccessError(415, "Only Markdown documents can be opened.");

  let before: ReturnType<typeof lstatSync>;
  try {
    safeAncestors(dirname(path));
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new DocumentAccessError(404, "Document was not found.");
    throw denied();
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    before.nlink !== 1
  )
    throw denied();
  if (before.size > maxBytes) throw new DocumentAccessError(413, "Document is too large to open.");
  try {
    if (realpathSync(path) !== path) throw denied();
  } catch (error) {
    if (error instanceof DocumentAccessError) throw error;
    throw denied();
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new DocumentAccessError(404, "Document was not found.");
    throw denied();
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid?.() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw denied();
    if (opened.size > maxBytes)
      throw new DocumentAccessError(413, "Document is too large to open.");

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(BUFFER_BYTES, maxBytes + 1 - bytes));
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor);
    if (bytes > maxBytes || after.size > maxBytes)
      throw new DocumentAccessError(413, "Document is too large to open.");
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes)
      throw new DocumentAccessError(404, "Document changed while it was being opened.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } catch {
      throw new DocumentAccessError(415, "Document is not valid UTF-8 Markdown.");
    }
  } finally {
    closeSync(descriptor);
  }
}

export class DocumentReader {
  private viewId?: string;
  private readonly grants = new Map<string, Grant>();
  private transcriptFingerprint?: string;
  private transcriptLinks = new Set<string>();

  constructor(
    private readonly source: DocumentContextSource,
    private readonly options: { home?: string; maxBytes?: number } = {},
  ) {}

  async load(request: DocumentRequest): Promise<LoadedDocument> {
    const context = await this.source.documentContext();
    if (!context?.current()) {
      this.viewId = undefined;
      this.grants.clear();
      this.transcriptFingerprint = undefined;
      this.transcriptLinks.clear();
      throw denied();
    }
    if (this.viewId !== context.viewId) {
      this.viewId = context.viewId;
      this.grants.clear();
      this.transcriptFingerprint = undefined;
      this.transcriptLinks.clear();
    }

    const fingerprint = transcriptFingerprint(context.assistantMarkdown);
    if (this.transcriptFingerprint !== fingerprint) {
      const links = new Set<string>();
      for (const source of context.assistantMarkdown) {
        for (const link of markdownLinks(source, MAX_TRANSCRIPT_LINKS - links.size))
          links.add(link);
        if (links.size >= MAX_TRANSCRIPT_LINKS) break;
      }
      this.transcriptFingerprint = fingerprint;
      this.transcriptLinks = links;
    }

    const home = resolve(this.options.home ?? homedir());
    const parsed = parseTarget(request.href, home);
    let root: string | undefined;
    let candidate: string;
    if (request.base) {
      const grant = this.grants.get(request.base);
      if (!grant?.links.has(request.href) || parsed.kind !== "relative") throw denied();
      root = grant.root;
      candidate = resolve(dirname(request.base), parsed.path);
    } else {
      if (!this.transcriptLinks.has(request.href)) throw denied();
      candidate =
        parsed.kind === "absolute" ? resolve(parsed.path) : resolve(context.workspace, parsed.path);
      root = permittedRoot(candidate, resolve(context.workspace), home);
    }
    if (!root || !contained(root, candidate)) throw denied();

    const content = readMarkdown(candidate, root, this.options.maxBytes ?? DEFAULT_MAX_BYTES);
    if (!context.current() || this.viewId !== context.viewId) throw denied();
    this.grants.delete(candidate);
    this.grants.set(candidate, { root, links: markdownLinks(content) });
    while (this.grants.size > MAX_DOCUMENT_GRANTS)
      this.grants.delete(this.grants.keys().next().value!);
    const extension = extname(candidate);
    return { title: basename(candidate, extension), path: candidate, content };
  }
}
