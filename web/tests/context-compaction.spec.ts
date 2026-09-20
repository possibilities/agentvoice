import { expect, test } from "@playwright/test";
import { contextCompactionMessage } from "../src/transcript-ui/lib/system-events.ts";
import type { LiveView } from "../src/types.ts";

const card = { id: "compact", ...contextCompactionMessage(true) };

test("system card renders in the Agent transcript and stays readable when narrow", async ({
  page,
}) => {
  const view: LiveView = {
    id: "compaction",
    phase: "live",
    agent: [card],
    voice: [card],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const pane = page.getByRole("region", { name: "Agent", exact: true });
  const note = pane.getByRole("note", { name: "Context compacted", exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("data-role", "system");
  await expect(note).toContainText(card.content);
  await expect(pane.locator(".message-author")).toHaveCount(0);
  await expect(pane.locator(".activity-group__trigger")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Voice", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/context-compaction.png", fullPage: true });
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(page.getByRole("note", { name: "Context compacted" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/context-compaction-narrow.png", fullPage: true });
});

test("card revisions retain row identity and unknown cards retain their fallback", async ({
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
  const note = page.getByRole("note", { name: "Compacting context", exact: true });
  await expect(note).toBeVisible();
  await note.evaluate((element) => element.setAttribute("data-retained", "yes"));
  await setMessages([card]);
  await expect(page.getByRole("note", { name: "Context compacted", exact: true })).toHaveAttribute(
    "data-retained",
    "yes",
  );
  await setMessages([
    {
      id: "unknown",
      role: "system",
      status: "complete",
      content: "Future system event",
      nativeItemType: "futureNativeEvent",
    },
  ]);
  await expect(page.getByText("Future system event", { exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);
});
