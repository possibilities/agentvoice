import { expect, test } from "@playwright/test";
import { toolOutputSections } from "../server/tool-output.ts";
import type { LiveView } from "../src/types.ts";

test("decoded tool text and original evidence remain readable in both lane widths", async ({
  page,
}) => {
  const text = "First output line\nSecond output line\nOUTPUT_TAIL";
  const output = JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ output: text, exit_code: 0 }) }],
  });
  const view: LiveView = {
    phase: "live",
    id: "tool-output",
    voice: [],
    agent: [
      {
        id: "tool",
        role: "tool",
        status: "complete",
        content: "",
        toolActivity: {
          name: "exec",
          detail: "functions.exec",
          state: "complete",
          sections: [...toolOutputSections(output), { label: "Original record", content: output }],
        },
      },
    ],
    agentControls: { available: true, active: true, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await page.locator(".tool-disclosure__trigger").click();
  const displayed = page.locator('pre[aria-label="Output"]');
  await expect(displayed).toHaveJSProperty("textContent", text);
  await expect(displayed).toHaveCSS("white-space", "pre-wrap");
  await expect(page.locator('pre[aria-label="Original record"]')).toHaveJSProperty(
    "textContent",
    output,
  );
  await page.screenshot({ path: "test-results/tool-output-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(displayed).toBeVisible();
  expect(await displayed.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/tool-output-narrow.png", fullPage: true });
});
