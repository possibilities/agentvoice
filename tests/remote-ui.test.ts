import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { runRemote } from "../src/console/remote-ui.ts";

function contentText(renderable: TextRenderable): string {
  return renderable.content.chunks.map((chunk) => chunk.text).join("");
}

describe("Remote console layout", () => {
  test("survives portrait-landscape-portrait resizing at the Chuchu viewport", async () => {
    const setup = await createTestRenderer({ width: 49, height: 46, exitOnCtrlC: false });
    const socketPath = join(tmpdir(), `av-remote-${process.pid}-${Date.now()}.sock`);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
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
    // The signal field animates continuously, so frames are never visually
    // idle; a resize has settled when the chromeless main region spans the
    // new viewport height exactly.
    const settled = (width: number, height: number): boolean => {
      const main = setup.renderer.root.findDescendantById("remote-main");
      return (
        setup.renderer.width === width &&
        main instanceof BoxRenderable &&
        main.y === 0 &&
        main.height === height
      );
    };
    const expectRegionsWithinViewport = (height: number): void => {
      const main = box("remote-main");
      const rails = box("remote-rails");
      const controls = box("remote-controls");
      expect(main.y).toBe(0);
      expect(rails.y + rails.height).toBeLessThanOrEqual(controls.y);
      expect(controls.y + controls.height).toBeLessThanOrEqual(height);
      expect(main.y + main.height).toBeLessThanOrEqual(height);
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("remote-field-canvas") !== undefined,
      );
      expectFieldWithin(49, 46);
      // The former masthead signals live inside the signal panel now, and
      // the palette affordance rides the readout row. flush() waits for an
      // idle the live signal field never reaches; render single frames.
      await setup.renderOnce();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("WAITING");
      expect(frame).toContain("⌃K commands");
      const palette = setup.renderer.root.findDescendantById("remote-palette");
      expect(palette).toBeInstanceOf(BoxRenderable);
      expect((palette as BoxRenderable).visible).toBe(false);

      setup.resize(103, 19);
      await setup.waitFor(() => settled(103, 19));
      expect(box("remote-rails").height).toBeGreaterThanOrEqual(7);
      expect(box("remote-controls").height).toBeGreaterThanOrEqual(7);
      expectRegionsWithinViewport(19);
      expectFieldWithin(103, 19);

      setup.resize(103, 14);
      await setup.waitFor(() => settled(103, 14));
      expect(box("remote-rails").height).toBeGreaterThanOrEqual(4);
      expect(box("remote-controls").height).toBe(6);
      expectRegionsWithinViewport(14);
      expectFieldWithin(103, 14);

      setup.resize(49, 46);
      await setup.waitFor(() => settled(49, 46));
      expect(box("remote-rails").height).toBeGreaterThan(7);
      expectRegionsWithinViewport(46);
      expectFieldWithin(49, 46);
    } finally {
      setup.mockInput.pressKey("k", { ctrl: true });
      // flush() waits for idle, which the live signal field never reaches;
      // one explicit frame is enough to lay the palette rows out.
      await setup.renderOnce();
      const quit = setup.renderer.root.findDescendantById("remote-palette-command-quit");
      expect(quit).toBeInstanceOf(BoxRenderable);
      await setup.mockMouse.click(quit!.x + 2, quit!.y);
      await remote;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
