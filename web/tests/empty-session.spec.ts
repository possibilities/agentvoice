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
  test(`empty views remain readable and preserve the composer at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const view = emptyView();
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const modes = page.getByRole("group", { name: "Transcript view" });
    const input = page.getByRole("textbox", { name: "Message Agent" });
    await input.fill("Keep this unsent draft");
    for (const mode of ["Agent", "Voice", "Both"]) {
      await modes.getByRole("button", { name: mode, exact: true }).click();
      await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const headings = page.getByRole("heading", { level: 2 });
      await expect(headings).toHaveCount(mode === "Both" ? 2 : 1);
      for (const heading of await headings.all()) {
        await expect(heading).toBeVisible();
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
      }
      await expect(page.getByText(/incomplete/)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      if (mode !== "Voice") {
        await expect(input).toHaveValue("Keep this unsent draft");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        const followUp = page.getByRole("button", { name: "Follow-up behavior" });
        const bounds = await followUp.boundingBox();
        const lane = await page.locator('[data-lane="agent"]').boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(lane!.x + lane!.width);
        await input.focus();
        await expect(input).toBeFocused();
        await expect(page.getByText("Start with a message below.")).toBeVisible();
      } else {
        await expect(input).toHaveCount(0);
        await expect(page.getByText("Spoken conversation will appear here.")).toBeVisible();
      }
      await page.screenshot({
        path: `test-results/empty-${viewport.width}-${mode.toLowerCase()}.png`,
      });
    }
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

test("empty notices remain truthful through interruption, streaming and recovery", async ({
  page,
}) => {
  const view = emptyView();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No voice text yet" })).toBeVisible();
  view.voiceNotice = "Some voice text is incomplete.";
  await expect(page.getByRole("status").filter({ hasText: view.voiceNotice })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No voice text yet" })).toHaveCount(0);
  view.voice = [{ id: "speech", role: "user", status: "streaming", content: "Speech arriving" }];
  await expect(page.getByText("Speech arriving")).toBeVisible();
  await expect(page.locator('[data-lane="voice"] .transcript-empty')).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: view.voiceNotice })).toBeVisible();
  view.voiceNotice = undefined;
  view.voice[0]!.status = "complete";
  await expect(page.getByText("Some voice text is incomplete.")).toHaveCount(0);
  view.agentControls!.available = false;
  view.phase = "unavailable";
  view.agentNotice = "Agent transcript disconnected. Reconnecting…";
  await expect(page.getByText("Start with a message below.")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: view.agentNotice })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Agent" })).toBeEditable();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});
