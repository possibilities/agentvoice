import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneConnection } from "../src/device.ts";
import { parseArgs } from "../src/main.ts";
import {
  type Phone,
  type PhoneState,
  type Profile,
  parsePreview,
  parseProfile,
  parseScales,
  parseState,
} from "../src/protocol.ts";
import { serveConfigurator } from "../src/server.ts";

const defaults = { speaking: 78, listening: 58, idle: 78 };
const initial = (): PhoneState => ({
  protocol: 1,
  revision: 0,
  holding: false,
  mode: "speaking",
  scales: { ...defaults },
  savedScales: { ...defaults },
  defaults: { ...defaults },
});
const profile = (state: PhoneState): Profile => ({
  version: 2,
  scaleMultipliers: {
    speaking: state.scales.speaking / 100,
    listening: state.scales.listening / 100,
    idle: state.scales.idle / 100,
  },
  verticalOffsetDp: 35,
  connectedArtboardScale: 1.9,
  disconnectedArtboardScale: 1.5,
  savedAtEpochMs: 1788917295182,
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakePhone implements Phone {
  state = initial();
  connected = true;
  generation = 1;
  calls: Record<string, unknown>[] = [];
  refuseSave = false;
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (command["method"] === "preview") {
      const preview = parsePreview({ mode: command["mode"], scales: command["scales"] });
      this.state = { ...this.state, ...preview, revision: this.state.revision + 1 };
    }
    if (command["method"] === "save") {
      if (this.refuseSave) throw Error("Save failed on phone");
      if (command["revision"] !== this.state.revision) throw Error("Stale revision");
      this.state = { ...this.state, savedScales: { ...this.state.scales } };
      return { state: this.state, profile: JSON.stringify(profile(this.state), null, 2) };
    }
    return { state: this.state };
  }
}

async function fixture(options: { saveTo?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-configurator-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const phone = new FakePhone();
  const saveTo = options.saveTo ?? join(directory, "profiles", "choice.json");
  const { server, url } = await serveConfigurator(phone, { port: 0, device: "Test phone", saveTo });
  cleanups.push(() => server.stop(true));
  const origin = new URL(url).origin;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...headers },
      body: JSON.stringify({ generation: phone.generation, ...(body as object) }),
    });
  return { phone, saveTo, url, origin, post };
}

test("CLI requires one explicit device and keeps the app separately runnable", () => {
  expect(() => parseArgs([])).toThrow("--device");
  expect(() => parseArgs(["--device", "phone", "--port", "65536"])).toThrow();
  expect(() => parseArgs(["--device", "phone", "--device", "other"])).toThrow();
  expect(parseArgs(["--device", "phone", "--port", "0"]).port).toBe(0);
});

test("preview protocol rejects out of range, fractional, unknown, or non-finite values", () => {
  expect(parseState(initial()).scales).toEqual(defaults);
  expect(() => parseScales({ ...defaults, listening: 121 })).toThrow();
  expect(() => parseScales({ ...defaults, listening: 58.5 })).toThrow();
  expect(() => parseScales({ ...defaults, listening: "58" })).toThrow();
  expect(() => parseScales({ ...defaults, listening: NaN })).toThrow();
  expect(() => parseScales({ ...defaults, offset: 35 })).toThrow();
  expect(() => parsePreview({ mode: "thinking", scales: defaults })).toThrow();
  const saved = profile(initial());
  expect(parseProfile(JSON.stringify(saved))).toEqual(saved);
  expect(() => parseProfile(JSON.stringify({ ...saved, verticalOffsetDp: 20 }))).toThrow();
});

test("browser updates one state and saves the exact phone receipt privately on host", async () => {
  const { phone, post, saveTo, url } = await fixture();
  expect((await (await fetch(new URL("state", url))).json()).state.scales).toEqual(defaults);
  expect(
    (await post("preview", { mode: "listening", scales: { ...defaults, listening: 52 } })).status,
  ).toBe(200);
  expect(phone.state.scales).toEqual({ ...defaults, listening: 52 });
  expect(await Bun.file(saveTo).exists()).toBe(false);
  const response = await post("save", { revision: phone.state.revision });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.hostSaved.scaleMultipliers.listening).toBe(0.52);
  expect(await readFile(saveTo, "utf8")).toBe(JSON.stringify(profile(phone.state), null, 2));
  expect((await stat(saveTo)).mode & 0o777).toBe(0o600);
  expect(phone.state.savedScales).toEqual(phone.state.scales);
});

test("invalid origins, hosts, routes, bodies and stale saves never mutate the phone", async () => {
  const { phone, post, url, origin } = await fixture();
  expect((await fetch(`${origin}/state`)).status).toBe(404);
  expect((await fetch(url, { headers: { Host: "attacker.invalid" } })).status).toBe(404);
  expect(
    (
      await post(
        "preview",
        { mode: "idle", scales: defaults },
        { Origin: "https://attacker.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post("preview", { mode: "idle", scales: { ...defaults, listening: 900 } })).status,
  ).toBe(400);
  expect((await post("save", { revision: 40 })).status).toBe(409);
  expect((await post("save", { revision: 0, path: "/arbitrary" })).status).toBe(400);
  expect((await fetch(new URL("state", url), { method: "OPTIONS" })).status).toBe(405);
  expect(phone.calls).toHaveLength(0);
  const page = await fetch(url);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await fetch(new URL("type.ttf", url))).status).toBe(200);
});

test("save refusal and phone loss never claim a saved host copy", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.refuseSave = true;
  expect((await post("save", { revision: 0 })).status).toBe(502);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  phone.connected = false;
  expect((await post("preview", { mode: "idle", scales: defaults })).status).toBe(503);
  expect(phone.calls).toHaveLength(1);
});

test("a host file failure reports that the phone saved but the host did not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-save-directory-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { phone, post } = await fixture({ saveTo: directory });
  const response = await post("save", { revision: 0 });
  expect(response.status).toBe(500);
  expect((await response.json()).error).toContain("Saved on the phone, but");
  expect(phone.calls[0]?.["method"]).toBe("save");
});

test("a returned phone rejects browser edits and saves from the previous connection", async () => {
  const { phone, post, saveTo, url } = await fixture();
  phone.connected = false;
  expect((await (await fetch(new URL("state", url))).json()).connected).toBe(false);
  phone.generation = 2;
  phone.connected = true;
  expect((await post("preview", { generation: 1, mode: "idle", scales: defaults })).status).toBe(
    409,
  );
  expect((await post("save", { generation: 1, revision: 0 })).status).toBe(409);
  expect((await post("preview", { generation: null, mode: "idle", scales: defaults })).status).toBe(
    400,
  );
  expect(phone.calls).toHaveLength(0);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  const state = await (await fetch(new URL("state", url))).json();
  expect(state.generation).toBe(2);
  expect(state.connected).toBe(true);
  expect(
    (await post("preview", { generation: state.generation, mode: "idle", scales: defaults }))
      .status,
  ).toBe(200);
});

async function wire() {
  let peer!: Socket;
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const server = createServer((socket) => {
    peer = socket;
    accept();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  const phone = new PhoneConnection(socket, "preview-test-token");
  await accepted;
  cleanups.push(() => {
    phone.close();
    peer.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { peer, phone };
}

test("device connection correlates split replies and fails pending work on disconnect", async () => {
  const { peer, phone } = await wire();
  const response = phone.request({ method: "get" });
  const frame = JSON.stringify({ id: 1, state: initial() });
  peer.write(frame.slice(0, 25));
  peer.write(`${frame.slice(25)}\n`);
  expect((await response).state.scales).toEqual(defaults);
  const pending = phone.request({ method: "save", revision: 0 });
  peer.destroy();
  await expect(pending).rejects.toThrow("disconnected");
  expect(phone.connected).toBe(false);
});

test("oversized or unrelated device replies cannot update the preview", async () => {
  const { peer, phone } = await wire();
  const pending = phone.request({ method: "get" });
  peer.write("x".repeat(8192));
  await expect(pending).rejects.toThrow("disconnected");
  expect(phone.state).toBeUndefined();
  const next = await wire();
  const requested = next.phone.request({ method: "get" });
  next.peer.write(`${JSON.stringify({ id: 99, state: initial() })}\n`);
  await expect(requested).rejects.toThrow("disconnected");
  expect(next.phone.state).toBeUndefined();
});
