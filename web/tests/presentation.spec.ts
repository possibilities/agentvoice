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
  await agent.getByText("Voice context", { exact: true }).click();
  await expect(agent.getByText("assistant: The build finished.", { exact: false })).toBeVisible();
  await agent.getByText("Original message", { exact: true }).click();
  await expect(agent.getByText(content, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(agent.getByRole("textbox", { name: "Message Agent" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
