import { expect, type Locator, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const anchor = (viewport: Locator) =>
  viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>("[data-windowed-row-key]")]
      .map((item) => ({ key: item.dataset.windowedRowKey, bounds: item.getBoundingClientRect() }))
      .filter((item) => item.bounds.bottom > bounds.top && item.bounds.top < bounds.bottom)
      .sort((a, b) => a.bounds.top - b.bounds.top)[0];
    return row ? { key: row.key, top: row.bounds.top } : null;
  });

test("both lanes release follow on the first small upward wheel and retain reading through updates", async ({
  page,
}) => {
  const view: LiveView = {
    id: "small-wheel-view",
    persistenceScope: "small-wheel-scope",
    phase: "live",
    agent: [],
    voice: [],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  for (const lane of ["agent", "voice"] as const) {
    view[lane] = Array.from({ length: 300 }, (_, index) => ({
      id: `${lane}-${index}`,
      role: "assistant",
      status: "complete",
      content: `${lane} entry ${index}. ${"A variable-length transcript fixture. ".repeat(4 + (index % 9))}`,
    }));
  }
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Draft stays while reading either lane");
  for (const lane of ["agent", "voice"] as const) {
    const name = lane === "agent" ? "Agent" : "Voice";
    const section = page.getByRole("region", { name, exact: true });
    const viewport = page.getByRole("region", { name: `${name} transcript`, exact: true });
    const gap = () => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(gap).toBeLessThan(2);
    await viewport.hover();
    await page.mouse.wheel(0, -1);
    await expect(
      section.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
    for (let count = 0; count < 3; count++) {
      await page.waitForTimeout(80);
      await page.mouse.wheel(0, -1);
    }
    const before = await anchor(viewport);
    expect(before).not.toBeNull();
    view[lane].push({
      id: `${lane}-new`,
      role: "assistant",
      status: "streaming",
      content: "New streamed entry.",
    });
    await expect(
      section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
    ).toBeVisible();
    // An input-intent timer must not resume following after the quiet interval.
    await page.waitForTimeout(1100);
    view[lane][view[lane].length - 1] = {
      ...view[lane][view[lane].length - 1]!,
      content: "Continued streaming. ".repeat(100),
    };
    await page.waitForTimeout(1200);
    const after = await anchor(viewport);
    expect(after?.key).toBe(before?.key);
    expect(Math.abs(after!.top - before!.top)).toBeLessThanOrEqual(2);
    await expect.poll(gap).toBeGreaterThan(64);
    await section
      .getByRole("button", { name: "1 new message. Jump to latest", exact: true })
      .click();
    await expect.poll(gap).toBeLessThan(2);
  }
  await expect(input).toHaveValue("Draft stays while reading either lane");
});
