import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CLIPBOARD_IMAGE_MIME_TYPES,
  type LocalImageAttachment,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_LOCAL_IMAGES,
} from "./image-contract.ts";

export const LOCAL_IMAGE_THREAD_QUOTA_BYTES = 256 * 1024 * 1024;
const MAX_THREAD_DIRECTORY_ENTRIES = 1_024;
const STALE_TEMP_MS = 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEMP_FILE =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type ClipboardImageMimeType = (typeof CLIPBOARD_IMAGE_MIME_TYPES)[number];
export type LocalImageIdentity = { workspace: string; threadId: string };
export type LocalImageSaveRequest = {
  identity: LocalImageIdentity;
  requestId: string;
  mimeType: ClipboardImageMimeType;
  chunks: AsyncIterable<Uint8Array>;
  current: () => boolean;
  cancelled?: () => boolean;
};
export type SavedLocalImage = {
  path: string;
  created: boolean;
  device: number;
  inode: number;
};

export class LocalImageError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 429 | 500,
    message: string,
  ) {
    super(message);
  }
}

function owner() {
  return process.getuid?.();
}

function extensionFor(mimeType: ClipboardImageMimeType) {
  return EXTENSIONS[mimeType];
}

function mimeForExtension(extension: string): ClipboardImageMimeType | undefined {
  return CLIPBOARD_IMAGE_MIME_TYPES.find((mimeType) => EXTENSIONS[mimeType] === extension);
}

function threadDirectory(identity: LocalImageIdentity) {
  return join(
    identity.workspace,
    ".agentvoice-images",
    createHash("sha256").update(identity.threadId).digest("hex"),
  );
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertWorkspace(workspace: string): void {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace)
    throw new Error("Invalid local image workspace");
  const info = lstatSync(workspace);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== owner() ||
    realpathSync(workspace) !== workspace
  )
    throw new Error("Unsafe local image workspace");
}

function privateDirectory(path: string, create: boolean): void {
  if (create) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== owner() ||
    realpathSync(path) !== path
  )
    throw new Error("Unsafe local image directory");
  if ((info.mode & 0o777) !== 0o700) {
    if (!create) throw new Error("Unsafe local image directory permissions");
    chmodSync(path, 0o700);
  }
}

function prepareDirectory(identity: LocalImageIdentity): string {
  assertWorkspace(identity.workspace);
  const root = join(identity.workspace, ".agentvoice-images");
  try {
    privateDirectory(root, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privateDirectory(root, false);
  }
  const directory = threadDirectory(identity);
  try {
    privateDirectory(directory, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privateDirectory(directory, false);
  }
  reclaimStaleTemps(directory);
  return directory;
}

function reclaimStaleTemps(directory: string): void {
  const handle = opendirSync(directory);
  let count = 0;
  let changed = false;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      count++;
      if (count > MAX_THREAD_DIRECTORY_ENTRIES) break;
      if (!TEMP_FILE.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== owner() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        Date.now() - info.mtimeMs < STALE_TEMP_MS
      )
        continue;
      unlinkSync(path);
      changed = true;
    }
  } finally {
    handle.closeSync();
  }
  if (changed) syncDirectory(directory);
}

function existingDirectory(identity: LocalImageIdentity): string {
  assertWorkspace(identity.workspace);
  const root = join(identity.workspace, ".agentvoice-images");
  privateDirectory(root, false);
  const directory = threadDirectory(identity);
  privateDirectory(directory, false);
  return directory;
}

function readOwnedFile(path: string): { bytes: Buffer; device: number; inode: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== owner() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size <= 0 ||
      info.size > MAX_CLIPBOARD_IMAGE_BYTES
    )
      throw new Error("Unsafe local image file");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("Incomplete local image file");
      offset += count;
    }
    return { bytes, device: Number(info.dev), inode: Number(info.ino) };
  } finally {
    closeSync(fd);
  }
}

function equal(bytes: Buffer, expected: number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function validPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 45 &&
    equal(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 &&
    bytes.readUInt32BE(bytes.length - 12) === 0 &&
    bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii") === "IEND"
  );
}

function validGif(bytes: Buffer): boolean {
  const header = bytes.subarray(0, 6).toString("ascii");
  return (
    bytes.length >= 14 &&
    (header === "GIF87a" || header === "GIF89a") &&
    bytes.readUInt16LE(6) > 0 &&
    bytes.readUInt16LE(8) > 0 &&
    bytes.subarray(13, -1).includes(0x2c) &&
    bytes.at(-1) === 0x3b
  );
}

function validWebp(bytes: Buffer): boolean {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false;
  const chunk = bytes.subarray(12, 16).toString("ascii");
  const chunkBytes = bytes.readUInt32LE(16);
  return (
    ["VP8 ", "VP8L", "VP8X"].includes(chunk) && chunkBytes > 0 && 20 + chunkBytes <= bytes.length
  );
}

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let frame = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0xd9) return frame && offset === bytes.length;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
      frame = bytes.readUInt16BE(offset + 3) > 0 && bytes.readUInt16BE(offset + 5) > 0;
    }
    if (marker === 0xda) return frame && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    offset += length;
  }
  return false;
}

function validateImage(bytes: Buffer, mimeType: ClipboardImageMimeType): void {
  const valid =
    mimeType === "image/png"
      ? validPng(bytes)
      : mimeType === "image/jpeg"
        ? validJpeg(bytes)
        : mimeType === "image/webp"
          ? validWebp(bytes)
          : validGif(bytes);
  if (!valid) throw new LocalImageError(400, "Image content does not match its declared type.");
}

function secureImage(
  path: string,
  mimeType: ClipboardImageMimeType,
): { bytes: Buffer; device: number; inode: number } {
  if (realpathSync(path) !== path) throw new Error("Unsafe local image path");
  const opened = readOwnedFile(path);
  validateImage(opened.bytes, mimeType);
  return opened;
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function directoryBytes(directory: string): number {
  const handle = opendirSync(directory);
  let count = 0;
  let total = 0;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      count++;
      if (count > MAX_THREAD_DIRECTORY_ENTRIES)
        throw new LocalImageError(413, "Image storage contains too many files.");
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== owner() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("Unsafe entry in local image storage");
      total += info.size;
      if (total > LOCAL_IMAGE_THREAD_QUOTA_BYTES)
        throw new LocalImageError(413, "Image storage limit reached for this conversation.");
    }
    return total;
  } finally {
    handle.closeSync();
  }
}

function assertCurrent(request: LocalImageSaveRequest, phase: "before" | "while"): void {
  if (request.cancelled?.() === true) throw new LocalImageError(409, "Image saving was cancelled.");
  if (!request.current())
    throw new LocalImageError(
      409,
      phase === "before"
        ? "The Agent view changed before saving."
        : "The Agent view changed while saving.",
    );
}

/** Private, bounded materialization for browser clipboard bytes. */
export class LocalImageStore {
  private active = 0;
  private publication: Promise<void> = Promise.resolve();

  async save(request: LocalImageSaveRequest): Promise<SavedLocalImage> {
    if (this.active >= MAX_LOCAL_IMAGES)
      throw new LocalImageError(429, "Too many images are being saved.");
    this.active++;
    try {
      return await this.saveImage(request);
    } finally {
      this.active--;
    }
  }

  discard(saved: SavedLocalImage): void {
    if (!saved.created) return;
    try {
      const info = lstatSync(saved.path);
      if (Number(info.dev) !== saved.device || Number(info.ino) !== saved.inode) return;
      unlinkSync(saved.path);
      syncDirectory(dirname(saved.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async saveImage(request: LocalImageSaveRequest): Promise<SavedLocalImage> {
    if (!UUID.test(request.requestId) || !CLIPBOARD_IMAGE_MIME_TYPES.includes(request.mimeType))
      throw new LocalImageError(400, "Invalid image request.");
    assertCurrent(request, "before");
    let directory: string;
    try {
      directory = prepareDirectory(request.identity);
    } catch (error) {
      throw error instanceof LocalImageError
        ? error
        : new LocalImageError(500, "Image storage is unavailable.");
    }
    const extension = extensionFor(request.mimeType);
    const target = join(directory, `${request.requestId}.${extension}`);
    const temporary = join(directory, `.${request.requestId}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.uid !== owner() || opened.nlink !== 1)
        throw new Error("Unsafe temporary local image");
      fchmodSync(fd, 0o600);
      let bytes = 0;
      for await (const value of request.chunks) {
        assertCurrent(request, "while");
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > MAX_CLIPBOARD_IMAGE_BYTES)
          throw new LocalImageError(413, "Image is larger than 10 MiB.");
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset);
          if (written <= 0) throw new Error("Incomplete local image write");
          offset += written;
        }
      }
      if (bytes === 0) throw new LocalImageError(400, "Image is empty.");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const incoming = secureImage(temporary, request.mimeType);
      assertCurrent(request, "while");
      return await this.exclusive(() => this.publish(request, temporary, target, incoming.bytes));
    } catch (error) {
      throw error instanceof LocalImageError
        ? error
        : new LocalImageError(500, "Image could not be saved.");
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  private publish(
    request: LocalImageSaveRequest,
    temporary: string,
    target: string,
    incoming: Buffer,
  ): SavedLocalImage {
    assertCurrent(request, "while");
    const directory = dirname(target);
    for (const mimeType of CLIPBOARD_IMAGE_MIME_TYPES) {
      const candidate = join(directory, `${request.requestId}.${extensionFor(mimeType)}`);
      const info = lstatSync(candidate, { throwIfNoEntry: false });
      if (!info) continue;
      if (candidate !== target)
        throw new LocalImageError(409, "Image request identity was already used.");
      const saved = secureImage(candidate, mimeType);
      if (saved.bytes.length !== incoming.length || hash(saved.bytes) !== hash(incoming))
        throw new LocalImageError(409, "Image request identity was reused with different bytes.");
      assertCurrent(request, "while");
      return { path: candidate, created: false, device: saved.device, inode: saved.inode };
    }
    directoryBytes(directory);
    assertCurrent(request, "while");
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return this.publish(request, temporary, target, incoming);
      throw error;
    }
    let saved: SavedLocalImage | undefined;
    try {
      const info = lstatSync(target);
      saved = {
        path: target,
        created: true,
        device: Number(info.dev),
        inode: Number(info.ino),
      };
      unlinkSync(temporary);
      syncDirectory(directory);
      assertCurrent(request, "while");
      return saved;
    } catch (error) {
      // The no-replace link succeeded. Remove only that publication if a later
      // durability or view-fence check fails while publication is serialized.
      try {
        if (saved) this.discard(saved);
        else {
          unlinkSync(target);
          syncDirectory(directory);
        }
      } catch {
        /* Preserve the publication failure; owned cleanup was attempted. */
      }
      throw error;
    }
  }

  private async exclusive<T>(run: () => T): Promise<T> {
    const before = this.publication;
    let release!: () => void;
    this.publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return run();
    } finally {
      release();
    }
  }
}

/** Revalidates generated local-image paths immediately before native dispatch. */
export function validateLocalImagePaths(
  images: readonly LocalImageAttachment[],
  identity: LocalImageIdentity,
): void {
  if (images.length > MAX_LOCAL_IMAGES) throw new Error("Too many local images");
  if (images.length === 0) return;
  const directory = existingDirectory(identity);
  const seen = new Set<string>();
  for (const image of images) {
    const path = image.path;
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      dirname(path) !== directory ||
      seen.has(path)
    )
      throw new Error("Invalid local image path");
    seen.add(path);
    const match = UUID.exec(basename(path).slice(0, 36));
    const name = basename(path);
    if (match?.[0].length !== 36 || name[36] !== ".")
      throw new Error("Invalid local image filename");
    const mimeType = mimeForExtension(name.slice(37));
    if (!mimeType) throw new Error("Invalid local image type");
    secureImage(path, mimeType);
  }
}
