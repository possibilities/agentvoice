import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveApi } from "../server/api.ts";
import {
  FILE_PICKER_MAX_ENTRIES,
  FILE_PICKER_MAX_SCANNED_ENTRIES,
  FilePicker,
  FilePickerAccessError,
  filePickerRequestSchema,
} from "../server/file-picker.ts";
import type { LiveView } from "../src/types.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-file-picker-")));
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(home, "Documents"));
  writeFileSync(join(home, "Documents", "notes.txt"), "private contents");
  writeFileSync(join(home, "photo.png"), "not read by the picker");
  writeFileSync(join(home, ".env"), "secret");
  mkdirSync(join(home, ".ssh"));
  symlinkSync(join(home, "Documents"), join(home, "linked-documents"));
  const picker = new FilePicker(home);
  return { root, home, picker, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("file picker returns bounded read-only metadata rooted at home", async () => {
  const h = fixture();
  try {
    const file = join(h.home, "photo.png");
    const before = statSync(file);
    const contents = readFileSync(file, "utf8");
    const listing = await h.picker.list({});
    expect(listing).toEqual({
      path: h.home,
      parent: null,
      entries: [
        { name: "Documents", path: join(h.home, "Documents"), kind: "directory" },
        { name: "photo.png", path: file, kind: "file" },
      ],
      truncated: false,
    });
    expect(readFileSync(file, "utf8")).toBe(contents);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);

    const nested = await h.picker.list({ path: join(h.home, "Documents"), query: "NOTE" });
    expect(nested.parent).toBe(h.home);
    expect(nested.entries).toEqual([
      { name: "notes.txt", path: join(h.home, "Documents", "notes.txt"), kind: "file" },
    ]);
  } finally {
    h.close();
  }
});

test("file picker rejects traversal, hidden folders and links without exposing special entries", async () => {
  const h = fixture();
  try {
    for (const path of [h.root, join(h.home, ".ssh"), join(h.home, "linked-documents")])
      await expect(h.picker.list({ path })).rejects.toMatchObject({ status: 403 });
    await expect(h.picker.list({ path: join(h.home, "missing") })).rejects.toMatchObject({
      status: 404,
    });
    for (const request of [
      { path: "relative" },
      { path: `${h.home}\nDocuments` },
      { query: "bad\u0000query" },
      { query: "x".repeat(257) },
      { extra: true },
    ])
      expect(filePickerRequestSchema.safeParse(request).success).toBe(false);
  } finally {
    h.close();
  }
});

test("file picker stops directory iteration at its public entry bound", async () => {
  const h = fixture();
  try {
    const many = join(h.home, "many");
    mkdirSync(many);
    for (let index = 0; index < FILE_PICKER_MAX_ENTRIES + 5; index++)
      writeFileSync(join(many, `row-${String(index).padStart(3, "0")}.txt`), "x");
    const listing = await h.picker.list({ path: many });
    expect(listing.entries).toHaveLength(FILE_PICKER_MAX_ENTRIES);
    expect(listing.truncated).toBe(true);
  } finally {
    h.close();
  }
});

test("file picker also bounds scanned entries when a filter has few matches", async () => {
  const h = fixture();
  try {
    const many = join(h.home, "scan-bound");
    mkdirSync(many);
    for (let index = 0; index < FILE_PICKER_MAX_SCANNED_ENTRIES + 5; index++)
      writeFileSync(join(many, `ordinary-${String(index).padStart(4, "0")}.txt`), "x");
    const listing = await h.picker.list({ path: many, query: "does-not-match" });
    expect(listing.entries).toEqual([]);
    expect(listing.truncated).toBe(true);
  } finally {
    h.close();
  }
});

test("unreadable directories fail with a stable permission error", async () => {
  if (process.getuid?.() === 0) return;
  const h = fixture();
  const blocked = join(h.home, "blocked");
  mkdirSync(blocked);
  chmodSync(blocked, 0);
  try {
    await expect(h.picker.list({ path: blocked })).rejects.toEqual(
      new FilePickerAccessError(403, "Folder cannot be opened."),
    );
  } finally {
    chmodSync(blocked, 0o700);
    h.close();
  }
});

test("file metadata HTTP API is POST-only, same-origin JSON and bounded", async () => {
  const h = fixture();
  const calls: unknown[] = [];
  const files = {
    list: async (request: unknown) => {
      calls.push(request);
      return h.picker.list(request as never);
    },
  };
  const reader = {
    read: async (): Promise<LiveView> => ({ phase: "empty", id: "empty", voice: [], agent: [] }),
  };
  const server = createServer((request, response) =>
    liveApi(
      reader,
      process.env,
      undefined,
      undefined,
      files,
    )(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/files`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body,
    });
  try {
    expect((await fetch(`${origin}/api/files`)).status).toBe(405);
    expect(
      (
        await fetch(`${origin}/api/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await send("{}", { Origin: "https://foreign.test" })).status).toBe(403);
    expect((await send("{}", { "Content-Type": "text/plain" })).status).toBe(403);
    expect((await send(JSON.stringify({ path: "relative" }))).status).toBe(400);
    expect((await send(JSON.stringify({ extra: true }))).status).toBe(400);
    expect((await send(JSON.stringify({ query: "x".repeat(17 * 1024) }))).status).toBe(413);
    expect(calls).toEqual([]);

    const response = await send(JSON.stringify({ query: "photo" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: h.home,
      parent: null,
      entries: [{ name: "photo.png", path: join(h.home, "photo.png"), kind: "file" }],
      truncated: false,
    });
    expect(calls).toEqual([{ query: "photo" }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.close();
  }
});

test("file metadata HTTP errors do not reveal host paths", async () => {
  const reader = {
    read: async (): Promise<LiveView> => ({ phase: "empty", id: "empty", voice: [], agent: [] }),
  };
  const files = {
    list: async () => {
      throw new Error("EACCES /private/credentials/token");
    },
  };
  const server = createServer((request, response) =>
    liveApi(
      reader,
      process.env,
      undefined,
      undefined,
      files,
    )(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/files`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Folder could not be listed." });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
