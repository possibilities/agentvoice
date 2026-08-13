import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createFleetFooter, type FleetFooterAction, footerCopy } from "../src/tui/footer.ts";

const actions: FleetFooterAction[] = [
  { id: "back", key: "ESC", label: "chats", onPress() {} },
  { id: "previous", key: "↑", label: "previous", shortLabel: "prev", onPress() {} },
  { id: "next", key: "↓", label: "next", onPress() {} },
  { id: "expand", key: "ENTER", label: "expand", onPress() {} },
  { id: "follow", key: "F", label: "follow", onPress() {} },
];

describe("fleet footer copy", () => {
  test("keeps full labels when they fit", () => {
    expect(footerCopy({ actions, mode: "FOLLOW", width: 100 })).toEqual({
      labels: ["chats", "previous", "next", "expand", "follow"],
      mode: "FOLLOW",
    });
  });

  test("shortens labels without dropping actions before the rail scrolls", () => {
    expect(footerCopy({ actions, mode: "FOLLOW", width: 40 })).toEqual({
      labels: ["", "", "", "", ""],
      mode: "",
    });
    expect(footerCopy({ actions, mode: "FOLLOW", width: 24 }).labels).toEqual(["", "", "", "", ""]);
  });

  test("keeps the mode and action rail on one row at half-screen widths", async () => {
    const setup = await createTestRenderer({ width: 72, height: 6 });
    const footer = createFleetFooter(core, setup.renderer, "test-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({ actions, mode: "FOLLOW", width: 72 });
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[ESC]");
    expect(frame).toContain("FOLLOW");
    expect(frame).not.toMatch(/^\s*F\s*$/m);
    expect(frame.split("\n").filter((row) => row.includes("[")).length).toBe(1);
    setup.renderer.destroy();
  });

  test("scrolls an overflowing rail horizontally with a touch-style vertical gesture", async () => {
    const setup = await createTestRenderer({ width: 24, height: 6 });
    const footer = createFleetFooter(core, setup.renderer, "touch-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({ actions, width: 24 });
    await setup.flush();

    const rail = setup.renderer.root.findDescendantById("touch-footer-actions");
    expect(rail).toBeInstanceOf(core.ScrollBoxRenderable);
    expect((rail as core.ScrollBoxRenderable).scrollLeft).toBe(0);
    await setup.mockMouse.scroll(rail!.x + 1, rail!.y, "down");
    await setup.flush();
    expect((rail as core.ScrollBoxRenderable).scrollLeft).toBeGreaterThan(0);
    setup.renderer.destroy();
  });

  test("routes a pointer tap on an action through the footer shell", async () => {
    const setup = await createTestRenderer({ width: 72, height: 6 });
    let pressed = "";
    const footer = createFleetFooter(core, setup.renderer, "pointer-footer", {
      field: "#111111",
      line: "#333333",
      accent: "#00ffff",
      muted: "#999999",
    });
    setup.renderer.root.add(footer.root);
    footer.update({
      width: 72,
      actions: actions.map((action) => ({
        ...action,
        onPress: () => {
          pressed = action.id;
        },
      })),
    });
    await setup.flush();

    const follow = setup.renderer.root.findDescendantById("pointer-footer-action-follow");
    expect(follow).toBeInstanceOf(core.BoxRenderable);
    await setup.mockMouse.click(follow!.x + 1, follow!.y);
    expect(pressed).toBe("follow");
    setup.renderer.destroy();
  });
});
