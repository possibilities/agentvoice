import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LOCAL_IMAGE_THREAD_QUOTA_BYTES,
  LocalImageStore,
  validateLocalImagePaths,
} from "../../src/attachment/local-images.ts";
import { liveApi } from "../server/api.ts";
import { LiveReader } from "../server/live-reader.ts";
import type { LiveView } from "../src/types.ts";
import { fixture as liveFixture } from "./fixture.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const WEBP = Buffer.from(
  "UklGRiYAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);

function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "av-local-images-")));
  const identity = { workspace, threadId: "thread/private/id" };
  const store = new LocalImageStore();
  const save = async (
    bytes = PNG,
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" = "image/png",
    requestId = randomUUID(),
    current = () => true,
  ) =>
    store.save({
      identity,
      requestId,
      mimeType,
      chunks: (async function* () {
        yield bytes;
      })(),
      current,
    });
  return {
    workspace,
    identity,
    store,
    save,
    close: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

test("clipboard images publish privately with MIME-derived extensions and validate for dispatch", async () => {
  const h = fixture();
  try {
    const saved: Array<{ path: string }> = [];
    for (const [mimeType, bytes, extension] of [
      ["image/png", PNG, "png"],
      ["image/jpeg", JPEG, "jpg"],
      ["image/webp", WEBP, "webp"],
      ["image/gif", GIF, "gif"],
    ] as const) {
      const row = await h.save(bytes, mimeType);
      expect(row.path.endsWith(`.${extension}`)).toBe(true);
      expect(readFileSync(row.path)).toEqual(bytes);
      expect(lstatSync(row.path).mode & 0o777).toBe(0o600);
      saved.push({ path: row.path });
    }
    const directory = dirname(saved[0]!.path);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(dirname(directory)).mode & 0o777).toBe(0o700);
    expect(directory).not.toContain(h.identity.threadId);
    expect(() => validateLocalImagePaths(saved, h.identity)).not.toThrow();
  } finally {
    h.close();
  }
});

test("stable image request identities are idempotent only for the same bytes and type", async () => {
  const h = fixture();
  try {
    const requestId = randomUUID();
    const first = await h.save(PNG, "image/png", requestId);
    const retry = await h.save(PNG, "image/png", requestId);
    expect(retry.path).toBe(first.path);
    expect(retry.created).toBe(false);

    const changed = Buffer.from(PNG);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await expect(h.save(changed, "image/png", requestId)).rejects.toMatchObject({ status: 409 });
    await expect(h.save(GIF, "image/gif", requestId)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(first.path)).toEqual(PNG);
  } finally {
    h.close();
  }
});

test("store rejects mismatched, oversized, foreign, linked and weakened image files", async () => {
  const h = fixture();
  try {
    await expect(h.save(PNG, "image/jpeg")).rejects.toMatchObject({ status: 400 });
    await expect(h.save(Buffer.alloc(10 * 1024 * 1024 + 1), "image/png")).rejects.toMatchObject({
      status: 413,
    });
    const valid = await h.save();
    const foreign = join(h.workspace, `${randomUUID()}.png`);
    writeFileSync(foreign, PNG, { mode: 0o600 });
    expect(() => validateLocalImagePaths([{ path: foreign }], h.identity)).toThrow();

    const linked = join(dirname(valid.path), `${randomUUID()}.png`);
    symlinkSync(valid.path, linked);
    expect(() => validateLocalImagePaths([{ path: linked }], h.identity)).toThrow();
    chmodSync(valid.path, 0o644);
    expect(() => validateLocalImagePaths([{ path: valid.path }], h.identity)).toThrow();
    chmodSync(valid.path, 0o600);
    expect(() =>
      validateLocalImagePaths(
        Array.from({ length: 5 }, () => ({ path: valid.path })),
        h.identity,
      ),
    ).toThrow("Too many");
  } finally {
    h.close();
  }
});

test("quota, concurrency and stale fences bound incomplete materialization", async () => {
  const h = fixture();
  try {
    const first = await h.save();
    const filler = join(dirname(first.path), ".quota-fixture.tmp");
    writeFileSync(filler, "", { mode: 0o600 });
    truncateSync(filler, LOCAL_IMAGE_THREAD_QUOTA_BYTES);
    await expect(h.save()).rejects.toMatchObject({ status: 413 });
  } finally {
    h.close();
  }

  const stale = fixture();
  try {
    let current = true;
    const result = stale.store.save({
      identity: stale.identity,
      requestId: randomUUID(),
      mimeType: "image/png",
      chunks: (async function* () {
        yield PNG.subarray(0, 10);
        current = false;
        yield PNG.subarray(10);
      })(),
      current: () => current,
    });
    await expect(result).rejects.toMatchObject({ status: 409 });
    const directory = join(stale.workspace, ".agentvoice-images");
    const thread = readdirSync(directory).map((name) => join(directory, name))[0]!;
    expect(readdirSync(thread)).toEqual([]);

    const abandoned = join(thread, `.${randomUUID()}.${randomUUID()}.tmp`);
    writeFileSync(abandoned, PNG, { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    utimesSync(abandoned, old, old);
    await stale.save();
    expect(existsSync(abandoned)).toBe(false);
  } finally {
    stale.close();
  }

  const concurrent = fixture();
  try {
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const requests = Array.from({ length: 4 }, () =>
      concurrent.store.save({
        identity: concurrent.identity,
        requestId: randomUUID(),
        mimeType: "image/png",
        chunks: (async function* () {
          started++;
          await gate.promise;
          yield PNG;
        })(),
        current: () => true,
      }),
    );
    for (let count = 0; started < 4 && count < 100; count++) await Bun.sleep(1);
    expect(started).toBe(4);
    await expect(concurrent.save()).rejects.toMatchObject({ status: 429 });
    gate.resolve();
    await Promise.all(requests);
  } finally {
    concurrent.close();
  }
});

test("LiveReader image context requires the exact actionable view and fences replacement", async () => {
  const h = await liveFixture();
  const reader = new LiveReader(h.stateDir);
  try {
    await h.start();
    let context = await reader.localImageContext();
    for (let count = 0; !context && count < 30; count++) {
      await Bun.sleep(20);
      context = await reader.localImageContext();
    }
    expect(context).toMatchObject({ workspace: h.root, threadId: "main" });
    expect(context?.current()).toBe(true);
    h.stopEvents();
    for (let count = 0; context?.current() && count < 30; count++) await Bun.sleep(10);
    expect(context?.current()).toBe(false);
    expect(await reader.localImageContext()).toBeUndefined();
  } finally {
    reader.close();
    await h.close();
  }
});

test("clipboard image HTTP endpoint enforces headers, body type and exact view", async () => {
  const h = fixture();
  const viewId = randomUUID();
  let current = true;
  const reader = {
    read: async (): Promise<LiveView> => ({ phase: "empty", id: "empty", voice: [], agent: [] }),
    localImageContext: async () => ({
      viewId,
      ...h.identity,
      current: () => current,
    }),
  };
  const server = createServer((request, response) =>
    liveApi(
      reader,
      process.env,
      undefined,
      undefined,
      undefined,
      h.store,
    )(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/clipboard-image`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "image/png",
        "X-AgentVoice-View-Id": viewId,
        "X-AgentVoice-Image-Id": randomUUID(),
        ...headers,
      },
      body: bytes,
    });
  try {
    expect((await fetch(`${origin}/api/clipboard-image`)).status).toBe(405);
    expect((await send(PNG, { Origin: "https://foreign.test" })).status).toBe(403);
    expect((await send(PNG, { "Content-Type": "application/octet-stream" })).status).toBe(403);
    expect((await send(PNG, { "X-AgentVoice-View-Id": randomUUID() })).status).toBe(409);
    expect((await send(GIF)).status).toBe(400);

    const requestId = randomUUID();
    const accepted = await send(PNG, { "X-AgentVoice-Image-Id": requestId });
    expect(accepted.status).toBe(200);
    const result = (await accepted.json()) as { path: string };
    expect(result.path).toMatch(new RegExp(`${requestId}\\.png$`));
    expect(readFileSync(result.path)).toEqual(PNG);
    current = false;
    expect((await send(PNG)).status).toBe(409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.close();
  }
});

test("post-save view replacement discards only a newly published image", async () => {
  const viewId = randomUUID();
  let current = true;
  let discarded = false;
  const reader = {
    read: async (): Promise<LiveView> => ({ phase: "empty", id: "empty", voice: [], agent: [] }),
    localImageContext: async () => ({
      viewId,
      workspace: "/unused",
      threadId: "unused",
      current: () => current,
    }),
  };
  const images = {
    save: async () => {
      current = false;
      return { path: "/private/new.png", created: true, device: 1, inode: 2 };
    },
    discard: () => {
      discarded = true;
    },
  };
  const server = createServer((request, response) =>
    liveApi(
      reader,
      process.env,
      undefined,
      undefined,
      undefined,
      images,
    )(request, response, () => response.writeHead(404).end()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/clipboard-image`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "image/png",
        "X-AgentVoice-View-Id": viewId,
        "X-AgentVoice-Image-Id": randomUUID(),
      },
      body: PNG,
    });
    expect(response.status).toBe(409);
    expect(discarded).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
