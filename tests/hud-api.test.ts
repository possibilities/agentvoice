import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildHudMcp } from "../src/hud/mcp.ts";
import { serveHud } from "../src/hud/server.ts";
import { WorkStore } from "../src/hud/store.ts";
import type { HudSnapshot } from "../src/hud/types.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hud-api-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkStore(join(dir, "state/work.sqlite3"));
  cleanup.push(() => store.close());
  return { dir, store };
}
test("read-only HTTP serves built assets, excludes filesystem escape and rejects cross-origin writes", async () => {
  const { dir, store } = fixture();
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<title>HUD fixture</title>");
  writeFileSync(join(dir, "outside"), "private");
  symlinkSync(join(dir, "outside"), join(dist, "escape"));
  const server = await serveHud({
    store,
    dist,
    port: 0,
    observe: async () => ({
      phase: "offline",
      inventory: "unavailable",
      threads: [],
      missingSettings: 0,
    }),
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP");
  const url = `http://127.0.0.1:${address.port}`;
  expect(await (await fetch(url)).text()).toContain("HUD fixture");
  const snap = (await (await fetch(`${url}/api/hud`)).json()) as HudSnapshot;
  expect(snap.native.availability).toBe("unavailable");
  expect(snap.store.works).toEqual([]);
  expect((await fetch(`${url}/api/hud`, { method: "POST", body: "{}" })).status).toBe(405);
  expect(
    (await fetch(`${url}/api/hud`, { headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  expect((await fetch(`${url}/api/hud`, { headers: { Host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${url}/api/hud?path=secret`)).status).toBe(400);
  expect((await fetch(`${url}/escape`)).status).toBe(404);
  expect((await fetch(`${url}/%2e%2e%2foutside`)).status).toBe(404);
  expect(store.snapshot().revision).toBe(0);
});
test("MCP exposes validated contract and same durable mutation idempotency", async () => {
  const { store } = fixture();
  const server = buildHudMcp(store);
  const client = new Client({ name: "hud-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const catalog = await client.listTools();
  expect(catalog.tools.map((tool) => tool.name)).toEqual([
    "agenthud_guide",
    "agenthud_snapshot",
    "agenthud_apply",
    "agenthud_batch",
  ]);
  const mutation = {
    action: "work.create",
    operationId: "create",
    actor: "lead",
    id: "work",
    expectedRevision: 0,
    data: {
      objective: "Task",
      scope: "Fixture",
      authority: [{ ref: "fixture:authority" }],
      lead: "lead",
    },
  };
  const first = await client.callTool({ name: "agenthud_apply", arguments: { mutation } });
  expect(first.isError).not.toBe(true);
  expect(
    (await client.callTool({ name: "agenthud_apply", arguments: { mutation } })).structuredContent,
  ).toEqual(first.structuredContent);
  const conflict = await client.callTool({
    name: "agenthud_apply",
    arguments: { mutation: { ...mutation, data: { ...mutation.data, objective: "Different" } } },
  });
  expect(conflict.isError).toBe(true);
  expect(store.snapshot().revision).toBe(1);
});
test("CLI guide and invalid usage do not open a Work database", () => {
  const dir = mkdtempSync(join(tmpdir(), "hud-cli-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: dir };
  const guide = Bun.spawnSync([process.execPath, "src/hud/main.ts", "guide", "--json"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(guide.exitCode).toBe(0);
  expect(JSON.parse(guide.stdout.toString()).data.x_mutation_schema).toBeDefined();
  const bad = Bun.spawnSync([process.execPath, "src/hud/main.ts", "apply", "--json", "{bad"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(bad.exitCode).toBe(1);
  expect(JSON.parse(bad.stderr.toString()).error.code).toBe("invalid_input");
});
