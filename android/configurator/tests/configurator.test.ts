import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDesign, parseDesign } from "../src/design.ts";
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
  profileDesign,
} from "../src/protocol.ts";
import { serveConfigurator } from "../src/server.ts";

const defaults = { speaking: 78, listening: 58, idle: 78 };
const initial = (): PhoneState => ({
  protocol: 4,
  connection: "connected",
  revision: 0,
  holding: false,
  mode: "speaking",
  scales: { ...defaults },
  savedScales: { ...defaults },
  defaults: { ...defaults },
  verticalOffsetDp: 35,
  savedVerticalOffsetDp: 35,
  defaultVerticalOffsetDp: 35,
  design: { ...defaultDesign },
  savedDesign: { ...defaultDesign },
  defaultDesign: { ...defaultDesign },
  micMuted: true,
  speakerMuted: false,
});
const profile = (state: PhoneState): Extract<Profile, { version: 4 }> => ({
  version: 4,
  design: { ...state.design },
  scaleMultipliers: {
    speaking: state.scales.speaking / 100,
    listening: state.scales.listening / 100,
    idle: state.scales.idle / 100,
  },
  verticalOffsetDp: state.verticalOffsetDp,
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
  wrongOffsetReceipt = false;
  wrongDesignReceipt: "height" | "share" | undefined;
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (command["method"] === "preview") {
      const preview = parsePreview({
        connection: command["connection"],
        mode: command["mode"],
        scales: command["scales"],
        verticalOffsetDp: command["verticalOffsetDp"],
        design: command["design"],
      });
      this.state = { ...this.state, ...preview, revision: this.state.revision + 1 };
    }
    if (command["method"] === "save") {
      if (this.refuseSave) throw Error("Save failed on phone");
      if (command["revision"] !== this.state.revision) throw Error("Stale revision");
      this.state = {
        ...this.state,
        savedScales: { ...this.state.scales },
        savedVerticalOffsetDp: this.state.verticalOffsetDp,
        savedDesign: { ...this.state.design },
      };
      const receipt = profile(this.state);
      if (this.wrongOffsetReceipt) receipt.verticalOffsetDp++;
      if (this.wrongDesignReceipt === "height") receipt.design.controlsHeightDp++;
      if (this.wrongDesignReceipt === "share") receipt.design.holdSharePercent++;
      return { state: this.state, profile: JSON.stringify(receipt, null, 2) };
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
      body: JSON.stringify({
        generation: phone.generation,
        ...(path === "preview"
          ? {
              connection: phone.state.connection,
              verticalOffsetDp: phone.state.verticalOffsetDp,
              design: phone.state.design,
            }
          : {}),
        ...(body as object),
      }),
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
  expect(() =>
    parsePreview({
      connection: "connected",
      mode: "thinking",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
    }),
  ).toThrow();
  const saved = profile(initial());
  expect(parseProfile(JSON.stringify(saved))).toEqual(saved);
  for (const verticalOffsetDp of [-200, 0, 20, 200]) {
    expect(parseProfile(JSON.stringify({ ...saved, verticalOffsetDp })).verticalOffsetDp).toBe(
      verticalOffsetDp,
    );
  }
  for (const verticalOffsetDp of [-201, 201, 20.5, "35", null, undefined]) {
    expect(() =>
      parsePreview({
        connection: "connected",
        mode: "idle",
        scales: defaults,
        verticalOffsetDp,
        design: defaultDesign,
      }),
    ).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, verticalOffsetDp }))).toThrow();
  }
});

test("design choices are bounded and old profiles remain readable without migration", () => {
  for (const mute of ["rockers", "keycaps"] as const)
    expect(parseDesign({ ...defaultDesign, mute })).toEqual({ ...defaultDesign, mute });
  expect(() => parseDesign({ ...defaultDesign, header: "remote-content" })).toThrow();
  for (const retired of [
    { header: "drawer" },
    { hold: "beam" },
    { mute: "glyphs" },
    { layout: "original" },
  ])
    expect(() => parseDesign({ ...defaultDesign, ...retired })).toThrow();
  expect(() => parseDesign({ ...defaultDesign, asset: "/arbitrary" })).toThrow();
  const { design: _, ...legacy } = profile(initial());
  const old = { ...legacy, version: 2 as const };
  expect(parseProfile(JSON.stringify(old))).toEqual(old);
  const v3 = {
    ...legacy,
    version: 3 as const,
    design: { layout: "studio", header: "drawer", mute: "keycaps", hold: "trigger" },
  };
  expect(parseProfile(JSON.stringify(v3))).toEqual(v3 as Profile);
  expect(profileDesign(parseProfile(JSON.stringify(v3)))).toEqual(defaultDesign);
  expect(() => parseProfile(JSON.stringify({ ...legacy, version: 4 }))).toThrow();
});

test("control dimensions and connection scenarios are bounded", () => {
  for (const controlsHeightDp of [240, 262, 480])
    for (const holdSharePercent of [30, defaultDesign.holdSharePercent, 60])
      expect(
        parseDesign({ ...defaultDesign, controlsHeightDp, holdSharePercent }).controlsHeightDp,
      ).toBe(controlsHeightDp);
  for (const controlsHeightDp of [239, 481, 300.5, "262", null, Infinity])
    expect(() => parseDesign({ ...defaultDesign, controlsHeightDp })).toThrow();
  for (const holdSharePercent of [29.9, 60.1, "44", null, NaN, Infinity])
    expect(() => parseDesign({ ...defaultDesign, holdSharePercent })).toThrow();
  expect(() =>
    parsePreview({
      connection: "reconnect-call",
      mode: "idle",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
    }),
  ).toThrow();
});

test("resizing controls preserves Persona tuning and only explicit Save keeps the design", async () => {
  const { phone, post, saveTo } = await fixture();
  const design = {
    ...defaultDesign,
    mute: "rockers" as const,
    controlsHeightDp: 380,
    holdSharePercent: 54.3,
  };
  const preview = {
    connection: "connecting",
    mode: "idle",
    scales: { ...defaults, speaking: 48 },
    verticalOffsetDp: -24,
    design,
  };
  expect((await post("preview", preview)).status).toBe(200);
  expect(phone.state.design).toEqual(design);
  expect(phone.state.scales).toEqual(preview.scales);
  expect(phone.state.savedDesign).toEqual(defaultDesign);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  expect(parseProfile(await readFile(saveTo, "utf8")).design).toEqual(design);
  expect(phone.state.savedDesign).toEqual(design);
});

test("a different design in the phone receipt is refused before writing the host copy", async () => {
  for (const field of ["height", "share"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongDesignReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("browser updates one state and saves the exact phone receipt privately on host", async () => {
  const { phone, post, saveTo, url } = await fixture();
  expect((await (await fetch(new URL("state", url))).json()).state.scales).toEqual(defaults);
  expect(
    (
      await post("preview", {
        mode: "listening",
        scales: { ...defaults, listening: 52 },
        verticalOffsetDp: -24,
      })
    ).status,
  ).toBe(200);
  expect(phone.state.scales).toEqual({ ...defaults, listening: 52 });
  expect(phone.state.verticalOffsetDp).toBe(-24);
  expect(phone.state.savedVerticalOffsetDp).toBe(35);
  expect(await Bun.file(saveTo).exists()).toBe(false);
  const response = await post("save", { revision: phone.state.revision });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.hostSaved.scaleMultipliers.listening).toBe(0.52);
  expect(saved.hostSaved.verticalOffsetDp).toBe(-24);
  expect(await readFile(saveTo, "utf8")).toBe(JSON.stringify(profile(phone.state), null, 2));
  expect((await stat(saveTo)).mode & 0o777).toBe(0o600);
  expect(phone.state.savedScales).toEqual(phone.state.scales);
  expect(phone.state.savedVerticalOffsetDp).toBe(-24);
});

test("a mismatched position receipt never claims a saved host copy", async () => {
  const { phone, post, saveTo } = await fixture();
  phone.wrongOffsetReceipt = true;
  const response = await post("save", { revision: 0 });
  expect(response.status).toBe(502);
  expect((await response.json()).error).toContain("different settings");
  expect(await Bun.file(saveTo).exists()).toBe(false);
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
