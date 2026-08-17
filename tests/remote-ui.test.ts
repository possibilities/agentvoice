import { describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { AUDIO_CONTROL_CLICK_MS, MuteGate } from "../src/console/audio-control.ts";
import {
  encodeRemoteMessage,
  parseRemoteCommand,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommand,
} from "../src/console/remote-protocol.ts";
import { runRemote } from "../src/console/remote-ui.ts";

function contentText(renderable: TextRenderable): string {
  return renderable.content.chunks.map((chunk) => chunk.text).join("");
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

describe("Remote console shared TUI", () => {
  test("uses one full-height signal field across portrait, landscape, and shallow viewports", async () => {
    const setup = await createTestRenderer({ width: 49, height: 46, exitOnCtrlC: false });
    const socketPath = join(tmpdir(), `av-remote-${process.pid}-${Date.now()}.sock`);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await listen(server, socketPath);
    const remote = runRemote(socketPath, { createRenderer: async () => setup.renderer });

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
      expectFieldFillsMain(46);
      expectFieldWithin(49, 46);
      const palette = setup.renderer.root.findDescendantById("voice-palette");
      expect(palette).toBeInstanceOf(BoxRenderable);
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
    const socketPath = join(tmpdir(), `av-remote-holds-${process.pid}-${Date.now()}.sock`);
    const sockets = new Set<Socket>();
    const commands: RemoteCommand[] = [];
    const mic = new MuteGate(true);
    const speaker = new MuteGate(false);
    let sequence = 0;
    let clock = 1_000;
    const server = createServer((socket) => {
      sockets.add(socket);
      let buffered = "";
      const sendState = (): void => {
        socket.write(
          encodeRemoteMessage({
            type: "state",
            protocol: REMOTE_PROTOCOL_VERSION,
            sequence: sequence++,
            phase: "live",
            liveForMs: 4_250,
            mic: { muted: mic.muted, effectiveMuted: mic.effectiveMuted, db: -42.4 },
            speaker: {
              muted: speaker.muted,
              effectiveMuted: speaker.effectiveMuted,
              db: -18.7,
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
          const command = parseRemoteCommand(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (!command) continue;
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
    const remote = runRemote(socketPath, {
      createRenderer: async () => setup.renderer,
      now: () => clock,
    });

    let commandCursor = 0;
    const expectCommands = async (expected: RemoteCommand[]): Promise<void> => {
      await setup.waitFor(() => commands.length >= commandCursor + expected.length);
      expect(commands.slice(commandCursor)).toEqual(expected);
      commandCursor += expected.length;
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("voice-rails") !== undefined,
      );
      await setup.renderOnce();
      await setup.waitFor(() => setup.captureCharFrame().includes("MUTED"));
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

      // A muted microphone opens immediately, then a long release restores mute.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => mic.holding);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("YOU × MUTED");
      expect(setup.captureCharFrame()).not.toContain("TALKING");
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.waitFor(() => setup.captureCharFrame().includes("TALKING"));
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => mic.effectiveMuted);
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "pointer" },
        { type: "release-unmuted", target: "mic", input: "pointer", commit: false },
      ]);

      // A quick release commits that unmute persistently.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => mic.holding);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("YOU × MUTED");
      expect(setup.captureCharFrame()).not.toContain("TALKING");
      clock += AUDIO_CONTROL_CLICK_MS;
      await setup.mockMouse.release(leftX, y);
      await setup.waitFor(() => !mic.muted);
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU ▷ INPUT"));
      expect(setup.captureCharFrame()).not.toContain("TALKING");
      await expectCommands([
        { type: "hold-unmuted", target: "mic", input: "pointer" },
        { type: "release-unmuted", target: "mic", input: "pointer", commit: true },
      ]);

      // A live microphone stays live while pressed and toggles only on release.
      await setup.mockMouse.pressDown(leftX, y);
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(leftX, y);
      await setup.waitFor(() => mic.muted);
      await expectCommands([{ type: "set-muted", target: "mic", muted: true }]);

      // The live speaker follows the same release-toggle behavior.
      await setup.mockMouse.pressDown(rightX, y);
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => speaker.muted);
      await expectCommands([{ type: "set-muted", target: "speaker", muted: true }]);

      // A muted speaker can be held open without changing its assignment.
      await setup.mockMouse.pressDown(rightX, y);
      await setup.waitFor(() => speaker.holding);
      await setup.waitFor(() => setup.captureCharFrame().includes("OUTPUT"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => speaker.effectiveMuted);
      await expectCommands([
        { type: "hold-unmuted", target: "speaker", input: "pointer" },
        { type: "release-unmuted", target: "speaker", input: "pointer", commit: false },
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
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU × MUTED"));
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
