import { expect, test } from "@playwright/test";
import { mapCodexSubagentEvent } from "../src/transcript-ui/lib/api/codex-subagent-event.ts";
import type { LiveView } from "../src/types.ts";

test("native subagent lifecycle projections have no transcript presentation", async ({ page }) => {
  const lifecycle = mapCodexSubagentEvent({
    id: "activity",
    kind: "completed",
    agentPath: "/root/review",
    agentThreadId: "child-thread",
  })!;
  const view: LiveView = {
    id: "lifecycle",
    phase: "live",
    voice: [],
    agent: [
      { id: "before", role: "assistant", status: "complete", content: "Before lifecycle" },
      { id: "lifecycle", ...lifecycle },
      { id: "after", role: "assistant", status: "complete", content: "After lifecycle" },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(transcript.getByText("Before lifecycle", { exact: true })).toBeVisible();
  await expect(transcript.getByText("After lifecycle", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Subagent turn completed", { exact: true })).toHaveCount(0);
  await expect(transcript.getByText("/root/review", { exact: true })).toHaveCount(0);
  await expect(transcript.getByText("child-thread", { exact: true })).toHaveCount(0);
});
