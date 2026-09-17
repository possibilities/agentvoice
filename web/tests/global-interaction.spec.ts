import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const needle = "Native browser find reaches this rendered transcript sentence.";

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

test("selection remains real and rendered transcript text remains findable", async ({ page }) => {
  const result = await page.getByText(needle, { exact: true }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selected = selection?.toString();
    selection?.removeAllRanges();
    return {
      selected,
      userSelect: getComputedStyle(element).userSelect,
      selectionBackground: getComputedStyle(element, "::selection").backgroundColor,
      found: (
        window as typeof window & {
          find(text: string): boolean;
        }
      ).find("Native browser find reaches this rendered transcript sentence."),
    };
  });

  expect(result.selected).toBe(needle);
  expect(result.userSelect).not.toBe("none");
  expect(result.selectionBackground).toBe("rgba(0, 0, 0, 0)");
  expect(result.found).toBe(true);
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
