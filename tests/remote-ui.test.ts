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

describe("Remote console layout", () => {
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
      const canvas = text("remote-field-canvas");
      const rows = contentText(canvas).split("\n");
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.width).toBeLessThanOrEqual(width);
      expect(canvas.height).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(height);
      expect(rows.every((row) => row.length <= width)).toBe(true);
    };
    const settled = (width: number, height: number): boolean => {
      const main = setup.renderer.root.findDescendantById("remote-main");
      return (
        setup.renderer.width === width &&
        main instanceof BoxRenderable &&
        main.y === 0 &&
        main.height === height
      );
    };
    const expectFieldFillsMain = (height: number): void => {
      const main = box("remote-main");
      const rails = box("remote-rails");
      expect(main.y).toBe(0);
      expect(rails.y + rails.height).toBeLessThanOrEqual(main.y + main.height);
      expect(main.y + main.height).toBeLessThanOrEqual(height);
      expect(setup.renderer.root.findDescendantById("remote-controls")).toBeUndefined();
      expect(setup.renderer.root.findDescendantById("remote-control-mic")).toBeUndefined();
      expect(setup.renderer.root.findDescendantById("remote-control-speaker")).toBeUndefined();
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("remote-field-canvas") !== undefined,
      );
      await setup.renderOnce();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("WAITING");
      expectFieldFillsMain(46);
      expectFieldWithin(49, 46);
      const palette = setup.renderer.root.findDescendantById("remote-palette");
      expect(palette).toBeInstanceOf(BoxRenderable);
      expect((palette as BoxRenderable).visible).toBe(false);

      setup.resize(103, 19);
      await setup.waitFor(() => settled(103, 19));
      expect(box("remote-rails").height).toBeGreaterThanOrEqual(7);
      expectFieldFillsMain(19);
      expectFieldWithin(103, 19);

      setup.resize(103, 7);
      await setup.waitFor(() => settled(103, 7));
      expect(box("remote-rails").height).toBeGreaterThanOrEqual(4);
      expectFieldFillsMain(7);
      expectFieldWithin(103, 7);

      setup.resize(49, 46);
      await setup.waitFor(() => settled(49, 46));
      expect(box("remote-rails").height).toBeGreaterThan(7);
      expectFieldFillsMain(46);
      expectFieldWithin(49, 46);
    } finally {
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.renderOnce();
      const quit = setup.renderer.root.findDescendantById("remote-palette-command-quit");
      expect(quit).toBeInstanceOf(BoxRenderable);
      await setup.mockMouse.click(quit!.x + 2, quit!.y);
      await remote;
      await closeServer(server, sockets);
    }
  });

  test("clicks persist and holds restore both signal-field channels", async () => {
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
            mic: { muted: mic.muted, effectiveMuted: mic.effectiveMuted, level: 0 },
            speaker: {
              muted: speaker.muted,
              effectiveMuted: speaker.effectiveMuted,
              level: 0,
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
          const gate = command.target === "mic" ? mic : speaker;
          if (command.type === "set-muted") gate.setMuted(command.muted);
          else if (command.type === "hold-muted") gate.hold(command.input, command.muted);
          else gate.release(command.input, command.commit);
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

    const count = (type: RemoteCommand["type"]): number =>
      commands.filter((command) => command.type === type).length;

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("remote-rails") !== undefined,
      );
      await setup.renderOnce();
      await setup.waitFor(() => setup.captureCharFrame().includes("MUTED"));
      const rails = setup.renderer.root.findDescendantById("remote-rails");
      expect(rails).toBeInstanceOf(BoxRenderable);
      const target = rails as BoxRenderable;
      const leftX = target.x + 2;
      const rightX = target.x + target.width - 2;
      const y = target.y + Math.max(1, Math.floor(target.height / 2));

      // A microphone hold opens immediately and restores the mute assignment.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => count("hold-muted") === 1);
      await setup.waitFor(() => setup.captureCharFrame().includes("TALKING"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => count("release-muted") === 1);
      await setup.waitFor(() => setup.captureCharFrame().includes("MUTED"));
      expect(commands.slice(0, 2)).toEqual([
        { type: "hold-muted", target: "mic", input: "pointer", muted: false },
        { type: "release-muted", target: "mic", input: "pointer", commit: false },
      ]);

      // A quick microphone click commits the same open state persistently.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => count("hold-muted") === 2);
      clock += AUDIO_CONTROL_CLICK_MS;
      await setup.mockMouse.release(leftX, y);
      await setup.waitFor(() => count("release-muted") === 2);
      await setup.waitFor(() => setup.captureCharFrame().includes("INPUT"));
      expect(mic.state()).toEqual({ muted: false, holding: false, effectiveMuted: false });

      // Holding the live microphone closes it, then restores it on release.
      await setup.mockMouse.pressDown(leftX, y);
      await setup.waitFor(() => count("hold-muted") === 3);
      await setup.waitFor(() => setup.captureCharFrame().includes("MUTED"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(leftX, y);
      await setup.waitFor(() => count("release-muted") === 3);
      await setup.waitFor(() => setup.captureCharFrame().includes("INPUT"));
      expect(mic.muted).toBe(false);

      // The speaker half follows the same click-versus-hold contract.
      await setup.mockMouse.pressDown(rightX, y);
      await setup.waitFor(() => count("hold-muted") === 4);
      clock += AUDIO_CONTROL_CLICK_MS;
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => count("release-muted") === 4);
      expect(speaker.state()).toEqual({ muted: true, holding: false, effectiveMuted: true });
      await setup.mockMouse.pressDown(rightX, y);
      await setup.waitFor(() => count("hold-muted") === 5);
      await setup.waitFor(() => setup.captureCharFrame().includes("OUTPUT"));
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      await setup.mockMouse.release(rightX, y);
      await setup.waitFor(() => count("release-muted") === 5);
      expect(speaker.state()).toEqual({ muted: true, holding: false, effectiveMuted: true });

      // Kitty M and S use the same click-versus-hold contract as the field.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:1u"));
      await setup.waitFor(() =>
        commands.some(
          (command) =>
            command.type === "hold-muted" &&
            command.target === "mic" &&
            command.input === "key" &&
            command.muted,
        ),
      );
      clock += AUDIO_CONTROL_CLICK_MS;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[109;1:3u"));
      await setup.waitFor(() =>
        commands.some(
          (command) =>
            command.type === "release-muted" &&
            command.target === "mic" &&
            command.input === "key" &&
            command.commit,
        ),
      );
      expect(mic.state()).toEqual({ muted: true, holding: false, effectiveMuted: true });

      setup.renderer.stdin.emit("data", Buffer.from("\x1b[115;1:1u"));
      await setup.waitFor(() =>
        commands.some(
          (command) =>
            command.type === "hold-muted" &&
            command.target === "speaker" &&
            command.input === "key" &&
            !command.muted,
        ),
      );
      clock += AUDIO_CONTROL_CLICK_MS + 1;
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[115;1:3u"));
      await setup.waitFor(() =>
        commands.some(
          (command) =>
            command.type === "release-muted" &&
            command.target === "speaker" &&
            command.input === "key" &&
            !command.commit,
        ),
      );
      expect(speaker.state()).toEqual({ muted: true, holding: false, effectiveMuted: true });

      // Kitty Space remains a dedicated, non-committing push-to-talk source.
      await setup.waitFor(() => setup.captureCharFrame().includes("YOU × MUTED"));
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:1u"));
      await setup.waitFor(() =>
        commands.some(
          (command) => command.type === "hold-muted" && command.input === "space" && !command.muted,
        ),
      );
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:3u"));
      await setup.waitFor(() =>
        commands.some(
          (command) =>
            command.type === "release-muted" && command.input === "space" && !command.commit,
        ),
      );
    } finally {
      setup.mockInput.pressKey("q");
      await remote;
      await closeServer(server, sockets);
    }
  });
});
