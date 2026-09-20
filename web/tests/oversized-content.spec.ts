import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../src/transcript-ui/transcript/index.ts";
import type { LiveView } from "../src/types.ts";

function omittedTool(
  id: string,
  status: "complete" | "error",
  nativeStatus: "completed" | "failed",
): TranscriptMessage {
  return {
    id,
    role: "tool",
    content: "",
    status,
    toolActivity: {
      name: "agenthud_snapshot",
      detail: "agenthud.agenthud_snapshot",
      meta: `${nativeStatus} · 744,808 bytes`,
      state: status === "error" ? "error" : "complete",
      sections: [
        ...(status === "error"
          ? [
              { label: "Error type", content: "service_error" },
              { label: "Error", content: "The HUD snapshot could not be completed." },
              { label: "Error details", content: "Retry after the store becomes readable." },
            ]
          : []),
        { label: "Result excerpt", content: '{\n  "revision": 653,\n  "works": […]\n}' },
        {
          label: "Omitted content",
          content:
            "The mcpToolCall item was 744,808 bytes. AgentVoice retained this bounded summary because the item exceeded the 49,152-byte transcript limit.",
        },
      ],
    },
  };
}

test("oversized tool content keeps real status, failure context, and omission details", async ({
  page,
}, testInfo) => {
  const view: LiveView = {
    phase: "live",
    id: "oversized-tools",
    voice: [],
    agent: [
      omittedTool("completed", "complete", "completed"),
      omittedTool("failed", "error", "failed"),
    ],
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");

  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  const group = agent.locator(".activity-group__trigger");
  await expect(group).toContainText("2 activities");
  await expect(group).toContainText("1 failed");
  await group.click();
  const completed = agent.locator(".tool-disclosure").filter({ hasText: "completed" });
  const failed = agent.locator(".tool-disclosure").filter({ hasText: "failed" });
  await expect(agent.locator(".tool-disclosure")).toHaveCount(2);
  await expect(agent.locator(".activity-group")).toHaveCount(1);
  await expect(completed.locator(".tool-disclosure__name")).toHaveText("agenthud_snapshot");
  await expect(failed.locator(".tool-disclosure__name")).toHaveText("Failed · agenthud_snapshot");
  await expect(agent.getByText("Content unavailable (oversized)")).toHaveCount(0);

  await failed.locator(".tool-disclosure__trigger").click();
  await expect(failed.getByLabel("Error type")).toHaveText("service_error");
  await expect(failed.getByLabel("Error", { exact: true })).toHaveText(
    "The HUD snapshot could not be completed.",
  );
  await expect(failed.getByLabel("Error details")).toHaveText(
    "Retry after the store becomes readable.",
  );
  await expect(failed.getByLabel("Result excerpt")).toContainText('"revision": 653');
  await expect(failed.getByLabel("Omitted content")).toContainText(
    "exceeded the 49,152-byte transcript limit",
  );
  await page.screenshot({
    path: testInfo.outputPath("oversized-tool-failure.png"),
    fullPage: true,
  });
});
