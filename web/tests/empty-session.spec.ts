import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

function emptyView(): LiveView {
  return {
    id: "empty-session",
    persistenceScope: "empty-session-scope",
    phase: "live",
    agent: [],
    voice: [],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`empty Agent view remains readable with a keyboard composer at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const view = emptyView();
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Message Agent" });
    await input.fill("Keep this unsent draft");
    await expect(page.getByRole("heading", { name: "No agent messages yet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No voice text yet" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Transcript view" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
    const heading = page.getByRole("heading", { name: "No agent messages yet" });
    const metrics = await heading.evaluate((el) => {
      const pane = el.closest(".transcript-lane")!.getBoundingClientRect();
      const copy = el.parentElement!.getBoundingClientRect();
      return {
        fits:
          copy.left >= pane.left &&
          copy.right <= pane.right &&
          copy.top >= pane.top &&
          copy.bottom <= pane.bottom,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        center: Math.abs((copy.top + copy.bottom) / 2 - (pane.top + pane.bottom) / 2),
      };
    });
    expect(metrics.fits).toBe(true);
    expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
    expect(metrics.center).toBeLessThan(2);
    await expect(input).toHaveValue("Keep this unsent draft");
    await input.focus();
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: `test-results/empty-agent-${viewport.width}.png` });

    view.agent.push({
      id: "first",
      role: "assistant",
      status: "complete",
      content: "The first answer.",
    });
    await expect(page.getByText("The first answer.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No agent messages yet" })).toHaveCount(0);
    await expect(input).toHaveValue("Keep this unsent draft");
  });
}

test("empty Agent view omits secondary notices while keeping its draft editable", async ({
  page,
}) => {
  const view = emptyView();
  view.voiceNotice = "Voice transcript was interrupted.";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await expect(page.getByText(view.voiceNotice, { exact: true })).toHaveCount(0);
  view.agentControls!.available = false;
  view.phase = "unavailable";
  view.agentNotice = "Agent transcript disconnected. Reconnecting…";
  await expect(page.getByText(view.agentNotice, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No agent messages yet" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await expect(input).toBeEditable();
  await input.fill("Retained while unavailable");
  await input.press("Enter");
  await expect(input).toHaveValue("Retained while unavailable");
});
