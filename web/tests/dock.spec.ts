import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

function fixture(): LiveView {
  return {
    phase: "live",
    persistenceScope: "dock.spec.ts-workspace-thread",
    id: "docked-call",
    voice: [],
    agent: Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      role: "assistant",
      status: "complete",
      content: `Earlier agent message ${i}.`,
    })),
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
}

test("blank Agent dock clicks focus the full-width composer without intercepting input", async ({
  page,
}) => {
  const view = fixture();
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");

  const dock = page.locator(".agent-dock");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await page.getByRole("region", { name: "Agent transcript" }).focus();
  await dock.click({ position: { x: 6, y: 6 } });
  await expect(input).toBeFocused();
  const dockBounds = (await dock.boundingBox())!;
  await dock.click({ position: { x: 6, y: dockBounds.height - 6 } });
  await expect(input).toBeFocused();

  await input.fill("Send from the dock");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.action).toBe("send");
});

for (const width of [1440, 390]) {
  test(`single dock remains stable and gives the textarea all freed space at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const view = fixture();
    view.agent = [];
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Message Agent" });
    const dock = page.locator(".agent-dock");
    const group = dock.locator('[data-slot="input-group"]');
    await expect(input).toBeVisible();
    await expect(page.locator(".voice-dock")).toHaveCount(0);
    await expect(page.locator('[data-slot="input-group-addon"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Send|Follow-up behavior|Reference a file/ }),
    ).toHaveCount(0);
    const geometry = async () => ({
      input: await input.boundingBox(),
      group: await group.boundingBox(),
      dock: await dock.boundingBox(),
    });
    const idle = await geometry();
    expect(idle.input!.width).toBe(idle.group!.width);
    expect(idle.input!.height).toBe(idle.group!.height);
    expect(idle.input!.height).toBeGreaterThanOrEqual(72);
    await input.focus();
    await expect(group).toHaveCSS("box-shadow", "none");

    view.agentControls!.active = true;
    await expect(page.locator(".transcript-composer__activity-line")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect((await geometry()).dock).toEqual(idle.dock);
    await input.fill(Array.from({ length: 30 }, () => "Draft line").join("\n"));
    const expanded = await geometry();
    expect(expanded.dock!.height).toBeGreaterThan(idle.dock!.height);
    expect(expanded.input!.width).toBe(expanded.group!.width);
    expect(await input.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(240);
    expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/composer-keyboard-only-${width}.png` });
  });
}
