import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { runRemote } from "../src/console/remote-ui.ts";

function contentText(renderable: TextRenderable): string {
  return renderable.content.chunks.map((chunk) => chunk.text).join("");
}

describe("Remote console layout", () => {
  test("survives portrait-landscape-portrait resizing at the Chuchu viewport", async () => {
    const setup = await createTestRenderer({ width: 49, height: 46 });
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
    // idle; a resize has settled when the bottom-anchored footer lands at the
    // new viewport height.
    const settled = (width: number, height: number): boolean => {
      const footer = setup.renderer.root.findDescendantById("remote-footer");
      return (
        setup.renderer.width === width &&
        footer instanceof BoxRenderable &&
        footer.y + footer.height === height
      );
    };
    const expectRegionsWithinViewport = (height: number): void => {
      const header = box("remote-header");
      const main = box("remote-main");
      const rails = box("remote-rails");
      const controls = box("remote-controls");
      const footer = box("remote-footer");
      expect(header.y + header.height).toBeLessThanOrEqual(main.y);
      expect(rails.y + rails.height).toBeLessThanOrEqual(controls.y);
      expect(controls.y + controls.height).toBeLessThanOrEqual(footer.y);
      expect(footer.y + footer.height).toBeLessThanOrEqual(height);
    };

    try {
      await setup.waitFor(
        () => setup.renderer.root.findDescendantById("remote-field-canvas") !== undefined,
      );
      expectFieldWithin(49, 46);
      const footer = setup.renderer.root.findDescendantById("remote-footer-actions");
      expect(footer).toBeInstanceOf(ScrollBoxRenderable);
      expect((footer as ScrollBoxRenderable).horizontalScrollBar.visible).toBe(false);
      expect((footer as ScrollBoxRenderable).verticalScrollBar.visible).toBe(false);

      setup.resize(103, 19);
      await setup.waitFor(() => settled(103, 19));
      expect(box("remote-rails").height).toBeGreaterThanOrEqual(4);
      expect(box("remote-controls").height).toBe(6);
      expect(text("remote-field-canvas").height).toBeGreaterThanOrEqual(2);
      expectRegionsWithinViewport(19);
      expectFieldWithin(103, 19);

      setup.resize(103, 22);
      await setup.waitFor(() => settled(103, 22));
      expect(box("remote-controls").height).toBe(6);
      expectRegionsWithinViewport(22);
      expectFieldWithin(103, 22);

      setup.resize(49, 46);
      await setup.waitFor(() => settled(49, 46));
      expect(box("remote-rails").height).toBeGreaterThan(7);
      expectRegionsWithinViewport(46);
      expectFieldWithin(49, 46);
    } finally {
      const quit = setup.renderer.root.findDescendantById("remote-footer-action-quit");
      expect(quit).toBeInstanceOf(BoxRenderable);
      await setup.mockMouse.click(quit!.x + 1, quit!.y, MouseButtons.LEFT);
      await remote;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
