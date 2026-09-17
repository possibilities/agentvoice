import { expect, type Locator, type Page, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const needle = "Native browser find reaches this rendered transcript sentence.";

async function dragSelectText(page: Page, target: Locator): Promise<string> {
  const points = await target.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) textNodes.push(node as Text);
    }
    const first = textNodes.at(0);
    const last = textNodes.at(-1);
    if (!first || !last) throw new Error("selection target has no readable text");

    const firstRange = document.createRange();
    firstRange.setStart(first, 0);
    firstRange.setEnd(first, 1);
    const lastRange = document.createRange();
    lastRange.setStart(last, last.length - 1);
    lastRange.setEnd(last, last.length);
    const firstRect = firstRange.getBoundingClientRect();
    const lastRect = lastRange.getBoundingClientRect();
    return {
      start: { x: firstRect.left - 1, y: firstRect.top + firstRect.height / 2 },
      end: { x: lastRect.right + 1, y: lastRect.top + lastRect.height / 2 },
    };
  });

  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test.beforeEach(async ({ page }) => {
  const view: LiveView = {
    id: "global-interaction",
    persistenceScope: "global-interaction-scope",
    phase: "live",
    voice: [],
    agent: [
      {
        id: "message",
        role: "assistant",
        status: "complete",
        content: needle,
      },
    ],
    agentControls: {
      available: true,
      active: false,
      pending: false,
      stopping: false,
      queue: [],
    },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await expect(page.getByText(needle, { exact: true })).toBeVisible();
});

test("focus frames stay hidden while semantic controls remain keyboard operable", async ({
  page,
}) => {
  const agentButton = page.getByRole("button", { name: "Agent", exact: true });
  await agentButton.focus();
  await expect(agentButton).toHaveCSS("outline-style", "none");
  await expect(agentButton).toHaveCSS("box-shadow", "none");
  await page.keyboard.press("Space");
  await expect(agentButton).toHaveAttribute("aria-pressed", "true");

  const viewport = page.getByRole("region", { name: "Agent transcript" });
  await viewport.focus();
  await expect(viewport).toBeFocused();
  await expect(viewport).toHaveCSS("outline-style", "none");
  await expect(viewport).toHaveCSS("box-shadow", "none");

  const dock = page.locator(".agent-dock");
  const restingDivider = await dock.evaluate((element) => getComputedStyle(element).borderTopColor);
  const composer = page.getByRole("textbox", { name: "Message Agent" });
  await composer.focus();
  await composer.fill("Keyboard input remains available");
  await expect(composer).toHaveValue("Keyboard input remains available");
  await expect(composer.locator("xpath=..")).toHaveCSS("box-shadow", "none");
  await expect(dock).toHaveCSS("border-top-color", restingDivider);
});

test("transcript text remains visibly selectable, copyable, and findable", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const message = page.getByText(needle, { exact: true });
  const beforeSelection = await message.screenshot();
  const selected = await dragSelectText(page, message);
  expect(selected).toContain(needle.slice(1, -1));
  expect(await message.screenshot()).not.toEqual(beforeSelection);

  await page.evaluate(() => navigator.clipboard.writeText("clipboard sentinel"));
  await page.keyboard.press("ControlOrMeta+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);

  const found = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    return (
      window as typeof window & {
        find(text: string): boolean;
      }
    ).find("Native browser find reaches this rendered transcript sentence.");
  });
  expect(found).toBe(true);
});

test("Command-F and Control-F stay uncancelled and bypass downstream page handlers", async ({
  page,
}) => {
  const outcomes = await page.evaluate(() => {
    const downstream = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", downstream);
    const dispatch = (modifier: "meta" | "control") => {
      const event = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: modifier === "meta",
        ctrlKey: modifier === "control",
        bubbles: true,
        cancelable: true,
      });
      const accepted = window.dispatchEvent(event);
      return { accepted, defaultPrevented: event.defaultPrevented };
    };
    const result = { command: dispatch("meta"), control: dispatch("control") };
    window.removeEventListener("keydown", downstream);
    return result;
  });

  expect(outcomes).toEqual({
    command: { accepted: true, defaultPrevented: false },
    control: { accepted: true, defaultPrevented: false },
  });
});
