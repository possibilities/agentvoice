import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDesign, parseDesign } from "../src/design.ts";
import { PhoneConnection } from "../src/device.ts";
import { defaultHalo, haloMotionFields, parseHalo } from "../src/halo.ts";
import { parseArgs } from "../src/main.ts";
import {
  type Phone,
  type PhoneState,
  type Profile,
  parsePreview,
  parseProfile,
  parseScales,
  parseState,
  previewOf,
  profileDesign,
  profileHalo,
  profileSpirit,
} from "../src/protocol.ts";
import { resetPreview } from "../src/resets.ts";
import { serveConfigurator } from "../src/server.ts";
import { defaultSpirit, parseSpirit } from "../src/spirit.ts";

const defaults = { speaking: 78, listening: 58, idle: 78 };
const initial = (): PhoneState => ({
  protocol: 8,
  activity: "steady",
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
  halo: defaultHalo(),
  savedHalo: defaultHalo(),
  defaultHalo: defaultHalo(),
  spirit: defaultSpirit(),
  savedSpirit: defaultSpirit(),
  defaultSpirit: defaultSpirit(),
  micMuted: true,
  speakerMuted: false,
});
const profile = (state: PhoneState): Extract<Profile, { version: 8 }> => ({
  version: 8,
  spirit: { ...state.spirit },
  design: { ...state.design },
  halo: structuredClone(state.halo),
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
  wrongSpiritReceipt: "surface" | "strengthPercent" | "persona" | undefined;
  oldReceipt = false;
  wrongHaloReceipt:
    | "variant"
    | "color"
    | "containedSizePercent"
    | (typeof haloMotionFields)[number]
    | undefined;
  wrongDesignReceipt: "height" | "share" | "mute" | "hold" | "composition" | undefined;
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (command["method"] === "preview") {
      const preview = parsePreview({
        ...previewOf(initial()),
        connection: command["connection"],
        activity: command["activity"],
        spirit: command["spirit"],
        mode: command["mode"],
        scales: command["scales"],
        verticalOffsetDp: command["verticalOffsetDp"],
        design: command["design"],
        halo: command["halo"],
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
        savedHalo: structuredClone(this.state.halo),
        savedSpirit: { ...this.state.spirit },
      };
      const receipt = profile(this.state);
      if (this.wrongOffsetReceipt) receipt.verticalOffsetDp++;
      if (this.wrongDesignReceipt === "height") receipt.design.controlsHeightDp++;
      if (this.wrongDesignReceipt === "share") receipt.design.holdSharePercent++;
      if (this.wrongDesignReceipt === "mute") Object.assign(receipt.design, { mute: "keycaps" });
      if (this.wrongDesignReceipt === "hold") Object.assign(receipt.design, { hold: "trigger" });
      if (this.wrongDesignReceipt === "composition") receipt.design.composition = "dock";
      if (this.wrongHaloReceipt === "variant") receipt.halo.variant = "contained";
      else if (this.wrongHaloReceipt === "color") receipt.halo.colors.idle = "#ffffff";
      else if (this.wrongHaloReceipt) receipt.halo[this.wrongHaloReceipt]++;
      if (this.wrongSpiritReceipt === "surface")
        receipt.spirit.surface = receipt.spirit.surface === "still" ? "soft" : "still";
      if (this.wrongSpiritReceipt === "strengthPercent")
        receipt.spirit.strengthPercent = (receipt.spirit.strengthPercent + 1) % 101;
      if (this.wrongSpiritReceipt === "persona")
        receipt.spirit.persona = receipt.spirit.persona === "fixed" ? "follow" : "fixed";
      return {
        state: this.state,
        profile: JSON.stringify(this.oldReceipt ? { ...receipt, version: 7 } : receipt, null, 2),
      };
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
              activity: phone.state.activity,
              spirit: phone.state.spirit,
              verticalOffsetDp: phone.state.verticalOffsetDp,
              design: phone.state.design,
              halo: phone.state.halo,
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
      ...previewOf(initial()),
      connection: "connected",
      mode: "thinking",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
      halo: defaultHalo(),
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
        ...previewOf(initial()),
        connection: "connected",
        mode: "idle",
        scales: defaults,
        verticalOffsetDp,
        design: defaultDesign,
        halo: defaultHalo(),
      }),
    ).toThrow();
    expect(() => parseProfile(JSON.stringify({ ...saved, verticalOffsetDp }))).toThrow();
  }
});

test("current design requires Rockers and old profiles remain readable without rewriting", () => {
  for (const composition of ["open", "dock", "yoke", "socket", "traces"] as const)
    expect(parseDesign({ ...defaultDesign, composition })).toEqual({
      ...defaultDesign,
      composition,
    });
  expect(() => parseDesign({ ...defaultDesign, header: "remote-content" })).toThrow();
  for (const retired of [
    { header: "drawer" },
    { hold: "beam" },
    { hold: "trigger" },
    { mute: "keycaps" },
    { mute: "glyphs" },
    { layout: "original" },
  ])
    expect(() => parseDesign({ ...defaultDesign, ...retired })).toThrow();
  expect(() => parseDesign({ ...defaultDesign, asset: "/arbitrary" })).toThrow();
  const { design: _, halo: _halo, spirit: _spirit, ...legacy } = profile(initial());
  const old = { ...legacy, version: 2 as const };
  expect(parseProfile(JSON.stringify(old))).toEqual(old);
  expect(profileHalo(parseProfile(JSON.stringify(old)))).toEqual(defaultHalo());
  const v3 = {
    ...legacy,
    version: 3 as const,
    design: { layout: "studio", header: "drawer", mute: "keycaps", hold: "trigger" },
  };
  expect(parseProfile(JSON.stringify(v3))).toEqual(v3 as Profile);
  expect(profileDesign(parseProfile(JSON.stringify(v3)))).toEqual(defaultDesign);
  const { composition: _composition, ...previous } = defaultDesign;
  const v4 = { ...legacy, version: 4 as const, design: { ...previous, hold: "trigger" as const } };
  expect(parseProfile(JSON.stringify(v4))).toEqual(v4);
  expect(profileHalo(parseProfile(JSON.stringify(v4)))).toEqual(defaultHalo());
  expect(() => parseProfile(JSON.stringify({ ...v4, version: 5 }))).toThrow();
  const v5 = {
    ...v4,
    version: 5 as const,
    halo: { ...defaultHalo(), variant: "contained" as const, containedSizePercent: 83 },
  };
  expect(parseProfile(JSON.stringify(v5))).toEqual(v5);
  expect(profileDesign(parseProfile(JSON.stringify(v5)))).toEqual(defaultDesign);
  expect(profileHalo(parseProfile(JSON.stringify(v5)))).toEqual(v5.halo);
  for (const saved of [v4, v5]) {
    expect(() =>
      parseProfile(JSON.stringify({ ...saved, design: { ...saved.design, hold: "rocker" } })),
    ).toThrow();
    expect(() =>
      parseProfile(JSON.stringify({ ...saved, design: { ...saved.design, composition: "dock" } })),
    ).toThrow();
  }
});

test("every legacy button choice migrates to Rockers while retaining other choices and reset scopes", () => {
  const latest = profile(initial());
  const { design: _design, halo: _halo, spirit: _spirit, ...base } = latest;
  const halo = { ...defaultHalo(), variant: "contained" as const, containedSizePercent: 93 };
  const spirit = { surface: "soft", strengthPercent: 77, persona: "follow" } as const;
  const candidates: unknown[] = [{ ...base, version: 2 }];
  for (const layout of ["original", "studio"])
    for (const header of ["quiet", "drawer", "none"])
      for (const mute of ["glyphs", "rockers", "keycaps"])
        for (const hold of ["beam", "trigger", "keycap"])
          candidates.push({ ...base, version: 3, design: { layout, header, mute, hold } });
  for (const version of [4, 5, 6, 7])
    for (const mute of ["rockers", "keycaps"])
      for (const hold of version < 6 ? ["trigger"] : ["trigger", "rocker"])
        for (const composition of version < 6
          ? [undefined]
          : version === 6
            ? ["open", "dock", "yoke"]
            : ["open", "dock", "yoke", "socket", "traces"])
          candidates.push({
            ...base,
            version,
            verticalOffsetDp: -72,
            scaleMultipliers: { speaking: 0.83, listening: 0.52, idle: 0.91 },
            design: {
              layout: "studio",
              header: "none",
              mute,
              hold,
              ...(composition ? { composition } : {}),
              controlsHeightDp: 371,
              holdSharePercent: 53.7,
            },
            ...(version >= 5 ? { halo } : {}),
            ...(version === 7 ? { spirit } : {}),
          });
  for (const candidate of candidates) {
    const encoded = JSON.stringify(candidate);
    const loaded = parseProfile(encoded);
    const design = profileDesign(loaded);
    expect(design.mute).toBe("rockers");
    expect(design.hold).toBe("rocker");
    if (loaded.version !== 2 && loaded.version !== 3) {
      expect(design).toEqual({
        ...loaded.design,
        composition: "composition" in loaded.design ? loaded.design.composition : "open",
        mute: "rockers",
        hold: "rocker",
      });
      expect(loaded.verticalOffsetDp).toBe(-72);
      expect(loaded.scaleMultipliers).toEqual({ speaking: 0.83, listening: 0.52, idle: 0.91 });
    } else expect(design).toEqual(defaultDesign);
    expect(profileHalo(loaded)).toEqual(loaded.version >= 5 ? halo : defaultHalo());
    expect(profileSpirit(loaded)).toEqual(loaded.version === 7 ? spirit : defaultSpirit());
    const current = {
      ...previewOf(initial()),
      design,
      halo: profileHalo(loaded),
      spirit: profileSpirit(loaded),
      activity: "voice" as const,
      verticalOffsetDp: loaded.verticalOffsetDp,
    };
    expect(resetPreview(current, initial(), "controls")).toEqual({
      ...current,
      design: {
        ...design,
        controlsHeightDp: defaultDesign.controlsHeightDp,
        holdSharePercent: defaultDesign.holdSharePercent,
      },
    });
    expect(resetPreview(current, initial(), "position")).toEqual({
      ...current,
      verticalOffsetDp: 35,
    });
    expect(JSON.stringify(loaded)).toBe(encoded);
  }
});

test("current previews, states and version 8 profiles reject retired styles before dispatch", async () => {
  const { phone, post } = await fixture();
  for (const change of [
    { mute: "keycaps" },
    { hold: "trigger" },
    { mute: "glyphs" },
    { hold: "beam" },
  ]) {
    const design = { ...defaultDesign, ...change };
    expect(() => parseProfile(JSON.stringify({ ...profile(initial()), design }))).toThrow();
    for (const field of ["design", "savedDesign", "defaultDesign"])
      expect(() => parseState({ ...initial(), [field]: design })).toThrow();
    expect((await post("preview", { mode: "idle", scales: defaults, design })).status).toBe(400);
  }
  expect(() => parseState({ ...initial(), protocol: 7 })).toThrow();
  expect(phone.calls).toHaveLength(0);
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
      ...previewOf(initial()),
      connection: "reconnect-call",
      mode: "idle",
      scales: defaults,
      verticalOffsetDp: 35,
      design: defaultDesign,
      halo: defaultHalo(),
    }),
  ).toThrow();
});

test("resizing controls preserves Persona tuning and only explicit Save keeps the design", async () => {
  const { phone, post, saveTo } = await fixture();
  const design = {
    ...defaultDesign,
    mute: "rockers" as const,
    hold: "rocker" as const,
    composition: "yoke" as const,
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
  for (const field of ["height", "share", "mute", "hold", "composition"] as const) {
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

test("Halo tuning bounds every field and accepts only opaque RGB colors", () => {
  const base = defaultHalo();
  expect(parseHalo(base)).toEqual(base);
  for (const key of haloMotionFields) {
    for (const value of [0, 100]) expect(parseHalo({ ...base, [key]: value })[key]).toBe(value);
    for (const value of [-1, 101, 25.5, "25", null, NaN, Infinity])
      expect(() => parseHalo({ ...base, [key]: value })).toThrow();
  }
  for (const value of [34, 121, 78.5, "78", null])
    expect(() => parseHalo({ ...base, containedSizePercent: value })).toThrow();
  expect(() => parseHalo({ ...base, variant: "remote" })).toThrow();
  expect(() => parseHalo({ ...base, asset: "/arbitrary" })).toThrow();
  for (const value of ["red", "#fff", "#ffffff80", "url(test)", "#zzzzzz", 0, null])
    expect(() => parseHalo({ ...base, colors: { ...base.colors, idle: value } })).toThrow();
  expect(parseHalo({ ...base, colors: { ...base.colors, idle: "#ABCDEF" } }).colors.idle).toBe(
    "#abcdef",
  );
  expect(() => parseHalo({ ...base, colors: { ...base.colors, extra: "#000000" } })).toThrow();
});

test("Contained saves motion colors and common size without replacing Original sizes", async () => {
  const { phone, post, saveTo } = await fixture();
  const halo = {
    ...defaultHalo(),
    variant: "contained" as const,
    containedSizePercent: 83,
    ringSpreadPercent: 42,
    listeningPulsePercent: 12,
    speakingMotionPercent: 65,
    idleBreathingPercent: 0,
    colors: { speaking: "#ff82dd", listening: "#44efbb", idle: "#eeedcc" },
  };
  const scales = { speaking: 80, listening: 53, idle: 75 };
  expect((await post("preview", { mode: "listening", scales, halo })).status).toBe(200);
  expect(phone.state.halo).toEqual(halo);
  expect(phone.state.savedHalo).toEqual(defaultHalo());
  expect(
    (await post("preview", { mode: "idle", scales, halo: { ...halo, variant: "original" } }))
      .status,
  ).toBe(200);
  expect(phone.state.scales).toEqual(scales);
  expect(phone.state.halo.containedSizePercent).toBe(83);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(8);
  expect(profileHalo(saved)).toEqual({ ...halo, variant: "original" });
  expect(phone.state.savedHalo).toEqual(phone.state.halo);
  expect("connection" in saved).toBe(false);
});

test("a mismatched Halo receipt cannot overwrite the host profile", async () => {
  for (const field of ["variant", "color", "containedSizePercent", ...haloMotionFields] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongHaloReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
});

test("granular resets preserve unrelated choices and do not mutate saved state", () => {
  const phone = initial();
  const selected = previewOf(phone);
  selected.mode = "listening";
  selected.design = {
    ...selected.design,
    mute: "rockers",
    hold: "rocker",
    composition: "dock",
    controlsHeightDp: 380,
    holdSharePercent: 55,
  };
  selected.scales = { speaking: 81, listening: 53, idle: 70 };
  selected.verticalOffsetDp = -24;
  selected.halo = {
    ...selected.halo,
    variant: "contained",
    containedSizePercent: 91,
    ringSpreadPercent: 82,
    listeningPulsePercent: 99,
    speakingMotionPercent: 73,
    idleBreathingPercent: 61,
    colors: { speaking: "#ff0000", listening: "#00ff00", idle: "#0000ff" },
  };
  selected.spirit = { surface: "soft", strengthPercent: 81, persona: "follow" };
  selected.activity = "voice";
  const before = structuredClone(selected);
  const saved = structuredClone(phone);
  const animation = resetPreview(selected, phone, "animation");
  expect(animation).toEqual({
    ...selected,
    halo: {
      ...selected.halo,
      ringSpreadPercent: 35,
      listeningPulsePercent: 25,
      speakingMotionPercent: 25,
      idleBreathingPercent: 25,
    },
  });
  expect(resetPreview(selected, phone, "colors")).toEqual({
    ...selected,
    halo: { ...selected.halo, colors: phone.defaultHalo.colors },
  });
  expect(resetPreview(selected, phone, "size")).toEqual({
    ...selected,
    halo: { ...selected.halo, containedSizePercent: 78 },
  });
  expect(resetPreview(selected, phone, "position")).toEqual({ ...selected, verticalOffsetDp: 35 });
  expect(resetPreview(selected, phone, "controls")).toEqual({
    ...selected,
    design: {
      ...selected.design,
      controlsHeightDp: 262,
      holdSharePercent: defaultDesign.holdSharePercent,
    },
  });
  expect(resetPreview(selected, phone, "light")).toEqual({
    ...selected,
    spirit: { ...selected.spirit, surface: "still", strengthPercent: 35 },
  });
  expect(resetPreview(selected, phone, "spirit-colors")).toEqual({
    ...selected,
    spirit: { ...selected.spirit, persona: "fixed" },
  });
  const original = { ...selected, halo: { ...selected.halo, variant: "original" as const } };
  expect(resetPreview(original, phone, "size")).toEqual({
    ...original,
    scales: { ...original.scales, listening: 58 },
  });
  expect(selected).toEqual(before);
  expect(phone).toEqual(saved);
});

test("spirit and activity validate exactly while Original retains its follow selection", () => {
  const base = defaultSpirit();
  expect(base).toEqual({ surface: "still", strengthPercent: 35, persona: "fixed" });
  for (const surface of ["still", "soft"] as const)
    for (const persona of ["fixed", "follow"] as const)
      for (const strengthPercent of [0, 35, 100])
        expect(parseSpirit({ surface, persona, strengthPercent })).toEqual({
          surface,
          persona,
          strengthPercent,
        });
  for (const strengthPercent of [-1, 101, 35.5, "35", null, undefined, NaN, Infinity])
    expect(() => parseSpirit({ ...base, strengthPercent })).toThrow();
  for (const change of [{ surface: "glow" }, { persona: "automatic" }, { asset: "remote" }])
    expect(() => parseSpirit({ ...base, ...change })).toThrow();
  expect(() => parseSpirit({ surface: "still", strengthPercent: 35 })).toThrow();
  const preview = previewOf(initial());
  for (const activity of ["steady", "voice"] as const) {
    const selected = parsePreview({ ...preview, activity, spirit: { ...base, persona: "follow" } });
    expect(selected.activity).toBe(activity);
    expect(selected.halo.variant).toBe("original");
    expect(previewOf(selected).spirit.persona).toBe("follow");
  }
  for (const activity of ["live", null, undefined]) {
    expect(() => parsePreview({ ...preview, activity })).toThrow();
    expect(() => parseState({ ...initial(), activity })).toThrow();
  }
  for (const field of ["spirit", "savedSpirit", "defaultSpirit"] as const)
    expect(() =>
      parseState({ ...initial(), [field]: { ...base, strengthPercent: 101 } }),
    ).toThrow();
});

test("old profile contracts keep exact fields and old compositions while spirit defaults in memory", () => {
  const { spirit: _spirit, ...latestWithoutSpirit } = profile(initial());
  const v6 = {
    ...latestWithoutSpirit,
    version: 6 as const,
    design: { ...defaultDesign, composition: "yoke" as const },
  };
  const encoded = JSON.stringify(v6);
  const decoded = parseProfile(encoded);
  expect(decoded).toEqual(v6);
  expect(JSON.stringify(decoded)).toBe(encoded);
  expect(profileSpirit(decoded)).toEqual(defaultSpirit());
  expect("spirit" in decoded).toBe(false);
  expect(profileDesign(decoded).composition).toBe("yoke");
  for (const composition of ["socket", "traces"])
    expect(() =>
      parseProfile(JSON.stringify({ ...v6, design: { ...v6.design, composition } })),
    ).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...v6, spirit: defaultSpirit() }))).toThrow();
  const v7 = {
    ...v6,
    version: 7,
    spirit: defaultSpirit(),
    design: { ...v6.design, composition: "socket" },
  };
  expect(profileSpirit(parseProfile(JSON.stringify(v7)))).toEqual(defaultSpirit());
  expect(() => parseProfile(JSON.stringify({ ...v7, activity: "voice" }))).toThrow();
  expect(() => parseProfile(JSON.stringify({ ...v7, spirit: undefined }))).toThrow();
});

test("spirit is unsaved until exact version 8 Save and activity never enters the profile", async () => {
  const { phone, post, saveTo } = await fixture();
  const spirit = { surface: "soft", strengthPercent: 72, persona: "follow" } as const;
  const design = { ...defaultDesign, composition: "traces" as const };
  expect(
    (
      await post("preview", {
        mode: "speaking",
        scales: defaults,
        activity: "voice",
        spirit,
        design,
      })
    ).status,
  ).toBe(200);
  expect(phone.state.spirit).toEqual(spirit);
  expect(phone.state.savedSpirit).toEqual(defaultSpirit());
  expect(phone.state.activity).toBe("voice");
  expect(await Bun.file(saveTo).exists()).toBe(false);
  expect((await post("save", { revision: phone.state.revision })).status).toBe(200);
  const saved = parseProfile(await readFile(saveTo, "utf8"));
  expect(saved.version).toBe(8);
  expect(profileSpirit(saved)).toEqual(spirit);
  expect(profileDesign(saved)).toEqual(design);
  expect(phone.state.savedSpirit).toEqual(spirit);
  expect("activity" in saved).toBe(false);
  expect("connection" in saved).toBe(false);
});

test("mismatched spirit or old-version receipts never publish a host copy", async () => {
  for (const field of ["surface", "strengthPercent", "persona"] as const) {
    const { phone, post, saveTo } = await fixture();
    phone.wrongSpiritReceipt = field;
    expect((await post("save", { revision: 0 })).status).toBe(502);
    expect(await Bun.file(saveTo).exists()).toBe(false);
  }
  const { phone, post, saveTo } = await fixture();
  phone.oldReceipt = true;
  expect((await post("save", { revision: 0 })).status).toBe(502);
  expect(await Bun.file(saveTo).exists()).toBe(false);
});

test("invalid activity or spirit never reaches the phone", async () => {
  const { phone, post } = await fixture();
  for (const change of [
    { activity: "live" },
    { spirit: { ...defaultSpirit(), strengthPercent: 101 } },
    { spirit: null },
  ])
    expect((await post("preview", { mode: "idle", scales: defaults, ...change })).status).toBe(400);
  expect(phone.calls).toHaveLength(0);
});
