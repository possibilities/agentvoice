import { expect, test } from "@playwright/test";
import { contextCompactionMessage } from "../src/transcript-ui/lib/system-events.ts";
import type { LiveView } from "../src/types.ts";

const event = { id: "compact", ...contextCompactionMessage(true) };

test("compaction uses the generic Tool call disclosure and stays readable when narrow", async ({
  page,
}) => {
  const view: LiveView = {
    id: "compaction",
    phase: "live",
    agent: [event],
    voice: [event],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const pane = page.getByRole("region", { name: "Agent", exact: true });
  const toolCall = pane.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Context compaction",
  });
  await expect(toolCall).toBeVisible();
  await expect(toolCall).toHaveAttribute("data-state", "complete");
  await expect(toolCall).toContainText(event.content);
  await expect(pane.locator(".message-author")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Voice", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/context-compaction.png", fullPage: true });
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(toolCall).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/context-compaction-narrow.png", fullPage: true });
});

test("system Tool call revisions retain row identity and unknown events stay readable", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  const initial = { id: "compact", ...contextCompactionMessage(false) };
  const setMessages = async (messages: unknown[]) =>
    page.evaluate((value) => {
      (
        window as unknown as { transcriptFixture: { setMessages(value: unknown[]): void } }
      ).transcriptFixture.setMessages(value);
    }, messages);
  await setMessages([initial]);
  const toolCall = page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Context compaction",
  });
  await expect(toolCall).toHaveAttribute("data-state", "running");
  await toolCall.evaluate((element) => element.setAttribute("data-retained", "yes"));
  await setMessages([event]);
  await expect(toolCall).toHaveAttribute("data-retained", "yes");
  await expect(toolCall).toHaveAttribute("data-state", "complete");
  await setMessages([
    {
      id: "unknown",
      role: "system",
      status: "complete",
      content: "Future system event",
      nativeItemType: "futureNativeEvent",
    },
  ]);
  await expect(
    page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
      hasText: "Future system event",
    }),
  ).toBeVisible();
});
