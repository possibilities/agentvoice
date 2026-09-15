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

for (const width of [1440, 390]) {
  test(`sparse transcripts keep top spacing and ignore follow-release gestures without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const view: LiveView = {
      id: "sparse-view",
      persistenceScope: "sparse-scope",
      phase: "live",
      agent: [{ id: "a", role: "assistant", status: "complete", content: "A short answer." }],
      voice: [{ id: "v", role: "user", status: "complete", content: "A short question." }],
      agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
    };
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    for (const lane of ["agent", "voice"] as const) {
      const name = lane === "agent" ? "Agent" : "Voice";
      const section = page.getByRole("region", { name, exact: true });
      const viewport = page.getByRole("region", { name: `${name} transcript`, exact: true });
      await expect(viewport).toBeVisible();
      await expect.poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
      await expect
        .poll(() =>
          viewport.evaluate((e) => {
            const row = e.querySelector<HTMLElement>("[data-windowed-row-key]")!;
            return row.getBoundingClientRect().top - e.getBoundingClientRect().top;
          }),
        )
        .toBeGreaterThanOrEqual(16);
      await viewport.hover();
      await page.mouse.wheel(0, -50);
      await viewport.focus();
      for (const key of ["ArrowUp", "PageUp", "Home", "Shift+Space"])
        await page.keyboard.press(key);
      await viewport.evaluate((element) => {
        for (const [type, clientY] of [
          ["touchstart", 100],
          ["touchmove", 160],
          ["touchend", 0],
        ] as const) {
          element.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              touches:
                type === "touchend" ? [] : [new Touch({ identifier: 1, target: element, clientY })],
            }),
          );
        }
      });
      await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
      view[lane].push({
        id: `${lane}-second`,
        role: "assistant",
        status: "complete",
        content: "Still fits.",
      });
      await expect(section.getByText("Still fits.")).toBeVisible();
      await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
      // A prior ineffective gesture must not leave subsequent overflowing text unfollowed.
      view[lane].push({
        id: `${lane}-long`,
        role: "assistant",
        status: "complete",
        content: "Growing conversation. ".repeat(300),
      });
      await expect
        .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight))
        .toBeGreaterThan(100);
      await expect
        .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop))
        .toBeLessThan(2);
      await viewport.hover();
      await page.mouse.wheel(0, -1);
      await expect(
        section.getByRole("button", { name: "Jump to latest", exact: true }),
      ).toBeVisible();
      // Returning to a fitting transcript clears the now-meaningless jump state.
      view[lane].pop();
      await expect.poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
      await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
    }
    await page.screenshot({ path: `test-results/sparse-${width}.png` });
  });
}

test("enlarging the viewport clears a jump state once all messages fit", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  const messages: LiveView["voice"] = Array.from({ length: 8 }, (_, i) => ({
    id: `resize-${i}`,
    role: "user",
    status: "complete",
    content: `Message ${i}`,
  }));
  await page.route("**/api/live", (route) =>
    route.fulfill({ json: { id: "resize", phase: "live", agent: [], voice: messages } }),
  );
  await page.goto("/");
  await page
    .getByRole("group", { name: "Transcript view" })
    .getByRole("button", { name: "Voice", exact: true })
    .click();
  const viewport = page.getByRole("region", { name: "Voice transcript", exact: true });
  await expect
    .poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight))
    .toBeGreaterThan(0);
  await viewport.focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 1000, height: 1600 });
  await expect.poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
  await expect(page.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
});
