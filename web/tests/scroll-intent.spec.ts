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

const tailBelowViewport = (viewport: Locator) =>
  viewport.evaluate((element) => {
    const viewportBounds = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-windowed-row-key]")];
    const tail = rows.at(-1)?.getBoundingClientRect();
    return tail ? tail.bottom > viewportBounds.bottom + 1 : false;
  });

const toolMessage = (id: string) => ({
  id,
  role: "tool" as const,
  status: "complete" as const,
  content: id,
  toolActivity: {
    name: "Command",
    detail: id,
    state: "complete" as const,
    sections: [{ label: "Output", content: `${id} finished` }],
  },
});

test("the Agent transcript releases follow on small upward wheels and retains reading through updates", async ({
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
  view.agent = Array.from({ length: 300 }, (_, index) => ({
    id: `agent-${index}`,
    role: "assistant",
    status: "complete",
    content: `agent entry ${index}. ${"A variable-length transcript fixture. ".repeat(4 + (index % 9))}`,
  }));
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Draft stays while reading the transcript");
  const section = page.getByRole("region", { name: "Agent", exact: true });
  const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
  const gap = () => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap).toBeLessThan(2);
  await viewport.hover();
  await page.mouse.wheel(0, -1);
  await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
  for (let count = 0; count < 3; count++) {
    await page.waitForTimeout(80);
    await page.mouse.wheel(0, -1);
  }
  const before = await anchor(viewport);
  expect(before).not.toBeNull();
  view.agent.push({
    id: "agent-new",
    role: "assistant",
    status: "streaming",
    content: "New streamed entry.",
  });
  await expect(
    section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
  ).toBeVisible();
  // An input-intent timer must not resume following after the quiet interval.
  await page.waitForTimeout(1100);
  view.agent[view.agent.length - 1] = {
    ...view.agent[view.agent.length - 1]!,
    content: "Continued streaming. ".repeat(100),
  };
  await page.waitForTimeout(1200);
  const after = await anchor(viewport);
  expect(after?.key).toBe(before?.key);
  expect(Math.abs(after!.top - before!.top)).toBeLessThanOrEqual(2);
  await expect.poll(gap).toBeGreaterThan(64);
  await section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }).click();
  await expect.poll(gap).toBeLessThan(2);
  await expect(input).toHaveValue("Draft stays while reading the transcript");
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
      voice: [{ id: "v", role: "user", status: "complete", content: "Hidden raw speech." }],
      agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
    };
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const section = page.getByRole("region", { name: "Agent", exact: true });
    const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
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
    for (const key of ["ArrowUp", "PageUp", "Home", "Shift+Space"]) await page.keyboard.press(key);
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
    view.agent.push({
      id: "agent-second",
      role: "assistant",
      status: "complete",
      content: "Still fits.",
    });
    await expect(section.getByText("Still fits.")).toBeVisible();
    await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
    // A prior ineffective gesture must not leave subsequent overflowing text unfollowed.
    view.agent.push({
      id: "agent-long",
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
    await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
    await page.mouse.wheel(0, -100);
    await expect.poll(() => tailBelowViewport(viewport)).toBe(true);
    await expect(
      section.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
    // Returning to a fitting transcript clears the now-meaningless jump state.
    view.agent.pop();
    await expect.poll(() => viewport.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
    await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
    await page.screenshot({ path: `test-results/sparse-${width}.png` });
  });
}

test("enlarging the viewport clears a jump state once all messages fit", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  const messages: LiveView["agent"] = Array.from({ length: 8 }, (_, i) => ({
    id: `resize-${i}`,
    role: "user",
    status: "complete",
    content: `Message ${i}`,
  }));
  await page.route("**/api/live", (route) =>
    route.fulfill({ json: { id: "resize", phase: "live", agent: messages, voice: [] } }),
  );
  await page.goto("/");
  const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
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

test("visible Agent tool updates stay out of the unread count until a new prose row is unseen", async ({
  page,
}) => {
  const messages: LiveView["agent"] = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `agent-lead-${index}`,
      role: "assistant" as const,
      status: "complete" as const,
      content: `Earlier message ${index}. ${"Scrollable history. ".repeat(4)}`,
    })),
    toolMessage("agent-tool-1"),
  ];
  const view: LiveView = {
    id: "agent-visible-tool-tail",
    persistenceScope: "agent-visible-tool-tail",
    phase: "live",
    agent: messages,
    voice: [],
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");

  const section = page.getByRole("region", { name: "Agent", exact: true });
  const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect.poll(() => tailBelowViewport(viewport)).toBe(false);
  await viewport.hover();
  await page.mouse.wheel(0, -1);
  await expect.poll(() => tailBelowViewport(viewport)).toBe(false);
  await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);

  for (let index = 2; index <= 4; index++) {
    messages.push(toolMessage(`agent-tool-${index}`));
    await expect(section.getByText(`${index} activities`, { exact: true })).toBeVisible();
    await expect.poll(() => tailBelowViewport(viewport)).toBe(false);
    await expect(section.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0);
  }

  messages.push({
    id: "agent-new-prose",
    role: "assistant",
    status: "complete",
    content: "A new prose message below the visible tail.",
  });
  await expect.poll(() => tailBelowViewport(viewport)).toBe(true);
  await expect(
    section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
  ).toBeVisible();
});

test("offscreen tool growth activates a generic jump control and mixed prose adds the count", async ({
  page,
}) => {
  const view: LiveView = {
    id: "offscreen-tool-tail",
    persistenceScope: "offscreen-tool-tail",
    phase: "live",
    agent: [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `lead-${index}`,
        role: "assistant" as const,
        status: "complete" as const,
        content: `Earlier message ${index}. ${"Scrollable history. ".repeat(4)}`,
      })),
      toolMessage("tool-1"),
      toolMessage("tool-2"),
    ],
    voice: [],
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");

  const section = page.getByRole("region", { name: "Agent", exact: true });
  const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
  await section.locator(".activity-group__trigger").click();
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await viewport.hover();
  await page.mouse.wheel(0, -1);
  await expect.poll(() => tailBelowViewport(viewport)).toBe(false);

  for (let index = 3; index <= 8 && !(await tailBelowViewport(viewport)); index++) {
    view.agent.push(toolMessage(`tool-${index}`));
    await expect(section.getByText(`${index} activities`, { exact: true })).toBeVisible();
  }
  await expect.poll(() => tailBelowViewport(viewport)).toBe(true);
  await expect(section.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: /new messages?\. Jump to latest/ })).toHaveCount(
    0,
  );

  view.agent.push({
    id: "mixed-prose",
    role: "assistant",
    status: "complete",
    content: "Prose added after unseen activity.",
  });
  await expect(
    section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
  ).toBeVisible();
});
