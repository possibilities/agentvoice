import { parseCodexMessagePresentation } from "@agentchats/transcript/codex";
import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("voice delegation is readable, preserves original details and uses shared lane density", async ({
  page,
}) => {
  const content =
    "<realtime_delegation>\n  <input>Check the deployment and report what changed.</input>\n  <transcript_delta>assistant: The build finished.\nuser: Check the deployment and report what changed.</transcript_delta>\n</realtime_delegation>";
  const view: LiveView = {
    phase: "live",
    id: "presentation",
    voice: [
      {
        id: "speech",
        role: "user",
        status: "complete",
        content: "Check the deployment and report what changed.",
      },
    ],
    agent: [
      {
        id: "delegation",
        role: "user",
        status: "complete",
        content,
        presentation: parseCodexMessagePresentation(content),
      },
      {
        id: "answer",
        role: "assistant",
        status: "complete",
        content:
          "The deployment finished. The shared transcript is wider, and the Agent pane supports typed input.",
      },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const agent = page.getByRole("region", { name: "Agent", exact: true });
  await expect(agent.getByText("Via Voice", { exact: true })).toBeVisible();
  await expect(
    agent.getByText("Check the deployment and report what changed.", { exact: true }),
  ).toBeVisible();
  await expect(agent.getByText(content, { exact: true })).not.toBeVisible();
  await page.screenshot({ path: "test-results/readable-delegation.png", fullPage: true });
  await expect(agent.getByRole("button", { name: "Voice context", exact: true })).toHaveCount(0);
  await expect(agent.getByRole("button", { name: "Original message", exact: true })).toHaveCount(0);
  const inspect = agent.getByRole("button", { name: "Inspect voice message" });
  await inspect.click();
  const dialog = page.getByRole("dialog", { name: "Voice message details" });
  for (const title of ["Displayed text", "Voice context", "Original message"])
    await expect(dialog.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(dialog.locator("pre").nth(1)).toHaveText(
    "assistant: The build finished.\nuser: Check the deployment and report what changed.",
  );
  await expect(dialog.locator("pre").nth(2)).toHaveText(content);
  await page.screenshot({ path: "test-results/voice-message-details.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(agent.getByRole("textbox", { name: "Message Agent" })).toBeInViewport();
  await inspect.click();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: "test-results/voice-message-details-narrow.png", fullPage: true });
  await dialog.getByRole("button", { name: "Close voice message details" }).click();
  await expect(inspect).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
