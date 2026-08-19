import { describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRenderable, type Renderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { AUDIO_CONTROL_CLICK_MS, MuteGate } from "../src/console/audio-control.ts";
import { runConsoleHost } from "../src/console/host.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  encodeControlFrame,
  parseControlCommand,
} from "../src/core/control-protocol.ts";
import {
  deviceIdFromPublicKey,
  serverProofPayload,
  verifyServerSignature,
} from "../src/core/pairing.ts";
import { ControlServer } from "../src/server/control.ts";
import { PairedDeviceStore } from "../src/server/paired-devices.ts";

function contentText(renderable: TextRenderable): string {
  return renderable.content.chunks.map((chunk) => chunk.text).join("");
}

function selectableTextIds(root: Renderable): string[] {
  const ids: string[] = [];
  const visit = (renderable: Renderable): void => {
    if (renderable instanceof TextRenderable && renderable.selectable) ids.push(renderable.id);
    for (const child of renderable.getChildren()) visit(child);
  };
  visit(root);
  return ids.sort();
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Console host network attachment", () => {
  test("says hello, mirrors the Server's state, and lands a command", async () => {
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const socketPath = join(tmpdir(), `av-host-net-${process.pid}-${Date.now()}.sock`);
    const token = "0123456789abcdef0123";
    const received: string[] = [];
    let sequence = 0;
    const server = new ControlServer({
      socketPath,
      network: { host: "127.0.0.1", port: 0, token },
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: sequence++,
        voice: {
          phase: "live",
          liveForMs: 4_250,
          mic: { muted: true, effectiveMuted: true, db: -42.4 },
          speaker: { muted: false, effectiveMuted: false, db: -18.7 },
        },
      }),
      onCommand: (command) => received.push(command.type),
    });
    await server.start();
    const [host, port] = server.networkAddress()!.split(":");
    const remote = runConsoleHost(
      { host: host!, port: Number(port), token },
      { tui: { createRenderer: async () => setup.renderer } },
    );

    try {
      // Nothing renders until hello clears: the Server sends no state first.
      await setup.waitFor(() => setup.captureCharFrame().includes("● LIVE 00:04"));
      expect(setup.captureCharFrame()).toContain("-42.4 dB");
      expect(setup.captureCharFrame()).toContain("-18.7 dB");
      setup.mockInput.pressKey("r");
      await setup.waitFor(() => received.includes("redial"));
      // The beat is not mistaken for an action.
      expect(received).toEqual(["redial"]);
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await server.close();
    }
  });

  test("resolves a route and answers a fresh challenge with the paired device key", async () => {
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const socketPath = join(tmpdir(), `av-host-paired-${process.pid}-${Date.now()}.sock`);
    const devicePath = `${socketPath}.devices.json`;
    const devices = PairedDeviceStore.open(devicePath);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const id = deviceIdFromPublicKey(publicKey);
    devices.pair({ id, name: "Samsung", publicKey, pairedAt: new Date().toISOString() });
    const server = new ControlServer({
      socketPath,
      network: { host: "127.0.0.1", port: 0, devices },
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: 1,
        voice: {
          phase: "live",
          liveForMs: 1_000,
          mic: { muted: true, effectiveMuted: true, db: -40 },
          speaker: { muted: false, effectiveMuted: false, db: -20 },
        },
      }),
      onCommand: () => {},
    });
    await server.start();
    const [host, port] = server.networkAddress()!.split(":");
    let resolutions = 0;
    let signatures = 0;
    const remote = runConsoleHost(
      {
        async resolve() {
          resolutions += 1;
          return {
            host: host!,
            port: Number(port),
            device: {
              id,
              async sign(payload: Uint8Array) {
                signatures += 1;
                return sign("sha256", payload, keys.privateKey).toString("base64url");
              },
            },
          };
        },
      },
      { tui: { createRenderer: async () => setup.renderer } },
    );

    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("● LIVE 00:01"));
      expect(resolutions).toBe(1);
      expect(signatures).toBe(1);
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await server.close();
      rmSync(devicePath, { force: true });
    }
  });
});

describe("Console host server proof", () => {
  const FIXTURE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIL15dvgxakr7NHcdTklqdfcb4jWZdQuRyxPMkvRQWxd5oAoGCCqGSM49
AwEHoUQDQgAEr04eS/umr0nk+U2EqcyFG0e0/UAXgvYuj1AzVZMcsIN+A/PFPlye
eR7k/M8MBCK++I29IzyFtvfczlv2gpmXEw==
-----END EC PRIVATE KEY-----
`;
  const FIXTURE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBcDCCARagAwIBAgIJAJZgQYOZ5MB5MAoGCCqGSM49BAMCMBUxEzARBgNVBAMM
CmFnZW50dm9pY2UwHhcNMjYwODE5MDUzMTU3WhcNNDYwODE0MDUzMTU3WjAVMRMw
EQYDVQQDDAphZ2VudHZvaWNlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr04e
S/umr0nk+U2EqcyFG0e0/UAXgvYuj1AzVZMcsIN+A/PFPlyeeR7k/M8MBCK++I29
IzyFtvfczlv2gpmXE6NPME0wFQYDVR0RBA4wDIIKYWdlbnR2b2ljZTAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATAK
BggqhkjOPQQDAgNIADBFAiEAkIOZ4q4kQCBx2AQXf5lAuBaVlqfQrrzOFuAJRHSU
f1gCIHvWlCyV0vYJ+b4I3hH48WzzG9jj43CGlyjkltCKzBMv
-----END CERTIFICATE-----
`;
  const SERVER_ID = "fixture-server";

  function proofRig(serverProof: (challenge: string, deviceId: string) => string | null) {
    const socketPath = join(tmpdir(), `av-host-proof-${process.pid}-${Date.now()}.sock`);
    const devicePath = `${socketPath}.devices.json`;
    const devices = PairedDeviceStore.open(devicePath);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const id = deviceIdFromPublicKey(publicKey);
    devices.pair({ id, name: "Samsung", publicKey, pairedAt: new Date().toISOString() });
    const server = new ControlServer({
      socketPath,
      network: { host: "127.0.0.1", port: 0, devices },
      serverProof,
      state: () => ({
        type: "state",
        protocol: CONTROL_PROTOCOL_VERSION,
        sequence: 1,
        voice: {
          phase: "live",
          liveForMs: 1_000,
          mic: { muted: true, effectiveMuted: true, db: -40 },
          speaker: { muted: false, effectiveMuted: false, db: -20 },
        },
      }),
      onCommand: () => {},
    });
    const device = (host: string, port: number) => ({
      host,
      port,
      device: {
        id,
        sign: async (payload: Uint8Array) =>
          sign("sha256", payload, keys.privateKey).toString("base64url"),
        verifyServer: (challenge: string, signature: string) =>
          verifyServerSignature(
            FIXTURE_CERTIFICATE,
            serverProofPayload({ challenge, serverId: SERVER_ID, deviceId: id }),
            signature,
          ),
      },
    });
    return { server, device, id, devicePath };
  }

  test("trusts the link only after the Server proves its identity", async () => {
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const rig = proofRig((challenge, deviceId) =>
      sign(
        "sha256",
        serverProofPayload({ challenge, serverId: SERVER_ID, deviceId }),
        createPrivateKey(FIXTURE_KEY),
      ).toString("base64url"),
    );
    await rig.server.start();
    const [host, port] = rig.server.networkAddress()!.split(":");
    const remote = runConsoleHost(
      {
        async resolve() {
          return rig.device(host!, Number(port));
        },
      },
      { tui: { createRenderer: async () => setup.renderer } },
    );
    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("● LIVE 00:01"));
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await rig.server.close();
      rmSync(rig.devicePath, { force: true });
    }
  });

  test("never leaves WAITING behind an impostor's proof", async () => {
    const setup = await createTestRenderer({ width: 49, height: 28, exitOnCtrlC: false });
    const rig = proofRig(() => "aW1wb3N0b3I");
    await rig.server.start();
    const [host, port] = rig.server.networkAddress()!.split(":");
    const remote = runConsoleHost(
      {
        async resolve() {
          return rig.device(host!, Number(port));
        },
      },
      { tui: { createRenderer: async () => setup.renderer } },
    );
    try {
      await Bun.sleep(600);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("WAITING");
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await rig.server.close();
      rmSync(rig.devicePath, { force: true });
    }
  });
});

describe("Console host shared TUI", () => {
  test("uses one full-height signal field across portrait, landscape, and shallow viewports", async () => {
    const setup = await createTestRenderer({ width: 49, height: 46, exitOnCtrlC: false });
    const socketPath = join(tmpdir(), `av-host-${process.pid}-${Date.now()}.sock`);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await listen(server, socketPath);
    const remote = runConsoleHost(socketPath, {
      tui: { createRenderer: async () => setup.renderer },
    });

    const box = (id: string): BoxRenderable => {
      const renderable = setup.renderer.root.findDescendantById(id);
      expect(renderable).toBeInstanceOf(BoxRenderable);
      return renderable as BoxRenderable;
    };
    const text = (id: string): TextRenderable => {
      const renderable = setup.renderer.root.findDescendantById(id);
      expect(renderable).toBeInstanceOf(TextRenderable);
      return renderable as TextRenderable;
    };
    const expectFieldWithin = (width: number, height: number): void => {
      const canvas = text("voice-field-canvas");
      const rows = contentText(canvas).split("\n");
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.width).toBeLessThanOrEqual(width);
      expect(canvas.height).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(height);
      expect(rows.every((row) => row.length <= width)).toBe(true);
    };
    const settled = (width: number, height: number): boolean => {
      const main = setup.renderer.root.findDescendantById("voice-main");
      return (
        setup.renderer.width === width &&
        main instanceof BoxRenderable &&
        main.y === 0 &&
        main.width === width &&
        main.height === height
      );
    };
    const expectFieldFillsMain = (height: number): void => {
      const main = box("voice-main");
      const rails = box("voice-rails");
      expect(main.y).toBe(0);
      expect(rails.y + rails.height).toBeLessThanOrEqual(main.y + main.height);
      expect(main.y + main.height).toBeLessThanOrEqual(height);
      expect(setup.renderer.root.findDescendantById("remote-controls")).toBeUndefined();
      expect(setup.renderer.root.findDescendantById("remote-control-mic")).toBeUndefined();
      expect(setup.renderer.root.findDescendantById("remote-control-speaker")).toBeUndefined();
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("voice-field-canvas") !== undefined,
      );
      await setup.renderOnce();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("WAITING");
      expect(setup.captureCharFrame()).toContain("/ 48 KHZ");
      expect(setup.captureCharFrame()).toContain("-∞  dB");
      expect(selectableTextIds(setup.renderer.root)).toEqual([]);
      expectFieldFillsMain(46);
      expectFieldWithin(49, 46);
      const palette = setup.renderer.root.findDescendantById("voice-palette");
      expect(palette).toBeInstanceOf(BoxRenderable);
      expect((palette as BoxRenderable).visible).toBe(false);
      const commandTrigger = box("voice-command-trigger");
      await setup.mockMouse.pressDown(
        commandTrigger.x + Math.floor(commandTrigger.width / 2),
        commandTrigger.y + Math.floor(commandTrigger.height / 2),
      );
      await setup.renderOnce();
      expect((palette as BoxRenderable).visible).toBe(true);
      expect(selectableTextIds(setup.renderer.root)).toEqual([]);
      expect(setup.captureCharFrame()).toContain("redial the voice link");
      expect(setup.captureCharFrame()).toContain("fresh orchestrator thread");
      setup.mockInput.pressKey("k", { ctrl: true });
      expect((palette as BoxRenderable).visible).toBe(false);

      setup.resize(120, 19);
      await setup.waitFor(() => settled(120, 19));
      expect(box("voice-rails").height).toBeGreaterThanOrEqual(7);
      expectFieldFillsMain(19);
      expectFieldWithin(120, 19);
      expect(setup.captureCharFrame()).toContain("/ 48 KHZ");

      setup.resize(80, 19);
      await setup.waitFor(() => settled(80, 19));
      expectFieldFillsMain(19);
      expectFieldWithin(80, 19);
      expect(setup.captureCharFrame()).toContain("/ 48 KHZ");

      setup.resize(40, 19);
      await setup.waitFor(() => settled(40, 19));
      expectFieldFillsMain(19);
      expectFieldWithin(40, 19);
      expect(setup.captureCharFrame()).not.toContain("/ 48 KHZ");
      expect(setup.captureCharFrame()).toContain("WAITING");

      setup.resize(103, 7);
      await setup.waitFor(() => settled(103, 7));
      expect(box("voice-rails").height).toBeGreaterThanOrEqual(4);
      expectFieldFillsMain(7);
      expectFieldWithin(103, 7);

      setup.resize(49, 46);
      await setup.waitFor(() => settled(49, 46));
      expect(box("voice-rails").height).toBeGreaterThan(7);
      expectFieldFillsMain(46);
      expectFieldWithin(49, 46);
    } finally {
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("redial the voice link");
      expect(setup.captureCharFrame()).toContain("fresh orchestrator thread");
      const quit = setup.renderer.root.findDescendantById("voice-palette-command-quit");
      expect(quit).toBeInstanceOf(BoxRenderable);
      await setup.mockMouse.click(quit!.x + 2, quit!.y);
      await remote;
      await closeServer(server, sockets);
    }
  });

  test("holds only unmute while live presses toggle on release", async () => {
    const setup = await createTestRenderer({
      width: 49,
      height: 28,
      exitOnCtrlC: false,
      kittyKeyboard: true,
    });
    const socketPath = join(tmpdir(), `av-host-holds-${process.pid}-${Date.now()}.sock`);
    const sockets = new Set<Socket>();
    const commands: ControlCommand[] = [];
    const mic = new MuteGate(true);
    const speaker = new MuteGate(false);
    let sequence = 0;
    let clock = 1_000;
    const server = createServer((socket) => {
      sockets.add(socket);
      let buffered = "";
      const sendState = (): void => {
        socket.write(
          encodeControlFrame({
            type: "state",
            protocol: CONTROL_PROTOCOL_VERSION,
            sequence: sequence++,
            voice: {
              phase: "live",
              liveForMs: 4_250,
              mic: { muted: mic.muted, effectiveMuted: mic.effectiveMuted, db: -42.4 },
              speaker: {
                muted: speaker.muted,
                effectiveMuted: speaker.effectiveMuted,
                db: -18.7,
              },
            },
          }),
        );
      };
      socket.setEncoding("utf8");
      sendState();
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline === -1) break;
          const command = parseControlCommand(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (!command || command.type === "hello" || command.type === "ping") continue;
          commands.push(command);
          if (command.type === "set-muted") {
            const gate = command.target === "mic" ? mic : speaker;
            gate.setMuted(command.muted);
          } else if (command.type === "hold-unmuted") {
            const gate = command.target === "mic" ? mic : speaker;
            gate.beginUnmute(command.input);
          } else if (command.type === "release-unmuted") {
            const gate = command.target === "mic" ? mic : speaker;
            gate.releaseUnmute(command.input, command.commit);
          }
          sendState();
        }
      });
      socket.once("close", () => sockets.delete(socket));
    });
    await listen(server, socketPath);
    const remote = runConsoleHost(socketPath, {
      tui: { createRenderer: async () => setup.renderer, now: () => clock },
    });

    let commandCursor = 0;
    const expectCommands = async (expected: ControlCommand[]): Promise<void> => {
      await setup.waitFor(() => commands.length >= commandCursor + expected.length);
      expect(commands.slice(commandCursor)).toEqual(expected);
      commandCursor += expected.length;
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("voice-rails") !== undefined,
      );
      await setup.renderOnce();
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU × PUSH"));
      expect(setup.captureCharFrame()).toContain("/ 48 KHZ");
      expect(setup.captureCharFrame()).toContain("-42.4 dB");
      expect(setup.captureCharFrame()).toContain("● LIVE 00:04");
      expect(setup.captureCharFrame()).toContain("-18.7 dB");
      expect(setup.captureCharFrame()).not.toContain("%");
      setup.mockInput.pressKey("r");
      await expectCommands([{ type: "redial" }]);
      setup.mockInput.pressKey("f");
      await expectCommands([{ type: "fresh" }]);
      const rails = setup.renderer.root.findDescendantById("voice-rails");
      expect(rails).toBeInstanceOf(BoxRenderable);
      const target = rails as BoxRenderable;
      const leftX = target.x + 2;
      const rightX = target.x + target.width - 2;
      const y = target.y + Math.max(1, Math.floor(target.height / 2));

      // The mic button is a plain toggle: the press flips mute, release does nothing.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => !mic.muted);
      await setup.mockMouse.release(leftX, y);
      await expectCommands([{ type: "set-muted", target: "mic", muted: false }]);
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU ▷ INPUT"));

      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => mic.muted);
      await setup.mockMouse.release(leftX, y);
      await expectCommands([{ type: "set-muted", target: "mic", muted: true }]);

      // The speaker button toggles the same way, one function per button.
      await setup.mockMouse.pressDown(rightX, y);
      await setup.waitFor(() => speaker.muted);
      await setup.mockMouse.release(rightX, y);
      await expectCommands([{ type: "set-muted", target: "speaker", muted: true }]);

      // The bottom band holds the muted mic open; a long release never commits.
      const pttY = target.y + target.height - 2;
      await setup.mockMouse.pressDown(leftX, pttY);
      await setup.waitFor(() => mic.holding);
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.waitFor(() => setup.captureCharFrame().includes("TALKING"));
      await setup.mockMouse.release(leftX, pttY);
      await setup.waitFor(() => mic.effectiveMuted);
      expect(setup.renderer.hasSelection).toBe(false);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "pointer" },
        { type: "release-unmuted", target: "mic", input: "pointer", commit: false },
      ]);

      // Even a quick tap on push-to-talk stays a hold, never a toggle.
      await setup.mockMouse.pressDown(leftX, pttY);
      await setup.waitFor(() => mic.holding);
      clock += AUDIO_CONTROL_CLICK_MS;
      await setup.mockMouse.release(leftX, pttY);
      await setup.waitFor(() => mic.effectiveMuted);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "pointer" },
        { type: "release-unmuted", target: "mic", input: "pointer", commit: false },
      ]);

      // Kitty M mirrors muted click and live release-toggle behavior.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:1u"));
      await setup.waitFor(() => mic.holding);
      clock += AUDIO_CONTROL_CLICK_MS;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:3u"));
      await setup.waitFor(() => !mic.muted);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "key" },
        { type: "release-unmuted", target: "mic", input: "key", commit: true },
      ]);

      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:1u"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:3u"));
      await setup.waitFor(() => mic.muted);
      await expectCommands([{ type: "set-muted", target: "mic", muted: true }]);

      // Kitty S can likewise commit an unmute with a quick release.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[115;1:1u"));
      await setup.waitFor(() => speaker.holding);
      clock += AUDIO_CONTROL_CLICK_MS;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[115;1:3u"));
      await setup.waitFor(() => !speaker.muted);
      await expectCommands([
        { type: "hold-unmuted", target: "speaker", input: "key" },
        { type: "release-unmuted", target: "speaker", input: "key", commit: true },
      ]);

      // A long Space hold opens the muted microphone only until release.
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU × PUSH"));
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:1u"));
      await setup.waitFor(() => mic.holding);
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:3u"));
      await setup.waitFor(() => mic.effectiveMuted);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "space" },
        { type: "release-unmuted", target: "mic", input: "space", commit: false },
      ]);

      // A quick Space click commits the unmute like the pointer control.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:1u"));
      await setup.waitFor(() => mic.holding);
      clock += AUDIO_CONTROL_CLICK_MS;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:3u"));
      await setup.waitFor(() => !mic.muted);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "space" },
        { type: "release-unmuted", target: "mic", input: "space", commit: true },
      ]);

      // Space leaves a live microphone alone until release, then mutes it.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:1u"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:3u"));
      await setup.waitFor(() => mic.muted);
      await expectCommands([{ type: "set-muted", target: "mic", muted: true }]);
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await closeServer(server, sockets);
    }
  });
});
