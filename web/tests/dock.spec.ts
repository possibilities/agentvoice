import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("Voice dock follows composer and queue height while both transcript viewports stay aligned", async ({
  page,
}) => {
  const view: LiveView = {
    phase: "live",
    id: "docked-call",
    voice: [
      { id: "voice", role: "user", status: "complete", content: "Voice stays on the right." },
    ],
    agent: [
      {
        id: "agent",
        role: "assistant",
        status: "complete",
        content: "Agent stays on the left, with room to compose.",
      },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const agent = page.getByRole("region", { name: "Agent", exact: true });
  const voice = page.getByRole("region", { name: "Voice", exact: true });
  const input = agent.getByRole("textbox", { name: "Message Agent" });
  await expect(input).toBeVisible();
  const dock = page.locator(".voice-dock");
  const height = () => dock.evaluate((el) => el.getBoundingClientRect().height);
  const alignment = () =>
    page.locator(".lane [role=region]").evaluateAll((regions) => {
      const [left, right] = regions
        .filter((el) => el.getAttribute("aria-label")?.endsWith("transcript"))
        .map((el) => el.getBoundingClientRect());
      return Math.abs(left!.bottom - right!.bottom);
    });
  await expect.poll(alignment).toBeLessThan(1);
  const initialHeight = await height();
  expect(initialHeight).toBeGreaterThan(80);
  expect((await agent.boundingBox())!.x).toBeLessThan((await voice.boundingBox())!.x);
  await expect(voice.getByRole("textbox")).toHaveCount(0);
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expect(dock.locator("button,input,textarea")).toHaveCount(0);
  await input.fill(
    "A longer draft\nwith several lines\nthat expands the composer\nwhile keeping both lanes\naligned at their lower edge.",
  );
  await expect.poll(height).toBeGreaterThan(initialHeight);
  await expect.poll(alignment).toBeLessThan(1);
  view.agentControls!.queue = [
    {
      id: "queued",
      text: "Review this after the current turn completes.",
      canSteer: true,
      canResume: false,
      disabled: false,
    },
  ];
  await expect(agent.getByRole("region", { name: "Queued messages" })).toBeVisible();
  await expect.poll(alignment).toBeLessThan(1);
  await page.screenshot({ path: "test-results/voice-dock.png", fullPage: true });
  await page.setViewportSize({ width: 600, height: 700 });
  await expect.poll(alignment).toBeLessThan(1);
  await expect(input).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/voice-dock-narrow.png", fullPage: true });
});
