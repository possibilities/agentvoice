import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("full-width dock dividers end both scroll areas and stay aligned as the composer grows", async ({
  page,
}) => {
  const view: LiveView = {
    phase: "live",
    persistenceScope: "dock.spec.ts-workspace-thread",
    id: "docked-call",
    voice: [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`,
        role: "assistant" as const,
        status: "complete" as const,
        content: `Earlier spoken message ${i}.`,
      })),
      { id: "voice", role: "user", status: "complete", content: "Voice stays on the right." },
    ],
    agent: [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `a${i}`,
        role: "assistant" as const,
        status: "complete" as const,
        content: `Earlier agent message ${i}.`,
      })),
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
  const verifyDivider = async () => {
    for (const lane of [agent, voice]) {
      const viewport = lane.getByRole("region", { name: /transcript$/ });
      const bottom = await viewport.evaluate((el) => el.getBoundingClientRect().bottom);
      const bottomDock = lane.locator(".agent-dock, .voice-dock");
      expect(bottom).toBe((await bottomDock.boundingBox())!.y);
      expect((await bottomDock.boundingBox())!.y + (await bottomDock.boundingBox())!.height).toBe(
        await page.evaluate(() => innerHeight),
      );
      const lastMessage = lane.locator('[data-slot="message"]').last();
      await expect
        .poll(
          async () =>
            (await lastMessage.boundingBox())!.y + (await lastMessage.boundingBox())!.height,
        )
        .toBeLessThan((await bottomDock.boundingBox())!.y);
      const dividerEdges = await lane.evaluate((el) => {
        const scroller = el.querySelector('[role="region"]')!.getBoundingClientRect();
        const dock = el.querySelector(".agent-dock, .voice-dock")!.getBoundingClientRect();
        return { left: scroller.left - dock.left, right: scroller.right - dock.right };
      });
      expect(dividerEdges).toEqual({ left: 0, right: 0 });
      await expect(lane.locator(".transcript-dock-clearance")).toHaveCount(0);
    }
  };
  await verifyDivider();
  const insetAlignment = await input.evaluate((textarea) => {
    const group = textarea.parentElement!;
    const mode = group.querySelector(".transcript-composer__mode")!;
    const range = document.createRange();
    range.selectNodeContents(mode.firstChild!);
    const style = getComputedStyle(textarea);
    const textLeft = textarea.getBoundingClientRect().left + parseFloat(style.paddingLeft);
    return Math.abs(range.getBoundingClientRect().left - textLeft);
  });
  expect(insetAlignment).toBeLessThan(1);
  await expect(agent.getByRole("heading", { name: "Agent", exact: true })).toHaveCSS(
    "font-size",
    "18px",
  );
  await expect(agent.getByRole("heading", { name: "Agent", exact: true })).toHaveCSS(
    "font-family",
    /Geist Mono/,
  );
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
  await verifyDivider();
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
  await verifyDivider();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/voice-dock-narrow.png", fullPage: true });
});

for (const width of [1440, 600]) {
  test(`composer remains still across Send, Working, Steer and Queue at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const view: LiveView = {
      phase: "live",
      persistenceScope: "dock.spec.ts-workspace-thread",
      id: "stable-composer",
      voice: [],
      agent: [],
      agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
    };
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Message Agent" });
    const dock = page.locator(".agent-dock");
    const height = () => dock.evaluate((el) => el.getBoundingClientRect().height);
    await expect(input).toBeVisible();
    await expect(dock.locator('[data-slot="input-group"]')).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await input.focus();
    await expect(dock.locator('[data-slot="input-group"]')).toHaveCSS("box-shadow", "none");
    await expect(dock.locator(".transcript-composer__content")).toHaveCSS("padding-top", "24px");
    await expect(dock.locator(".transcript-composer__content")).toHaveCSS("padding-left", "26px");
    const initial = await height();
    const stable = async () => {
      await expect.poll(height).toBe(initial);
      await expect
        .poll(() => page.locator(".voice-dock").evaluate((el) => el.getBoundingClientRect().height))
        .toBe(initial);
    };
    view.agentControls!.active = true;
    await expect(page.locator(".transcript-composer__activity-line")).toHaveAttribute(
      "data-active",
      "true",
    );
    await stable();
    const working = page.locator(".transcript-composer__activity-line");
    const workingBox = (await working.boundingBox())!;
    const dockBox = (await dock.boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    expect(workingBox.x).toBe(dockBox.x);
    expect(workingBox.width).toBe(dockBox.width);
    expect(Math.abs(workingBox.y - dockBox.y)).toBeLessThanOrEqual(1);
    expect(workingBox.height).toBe(3);
    expect(await working.evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe(
      "none",
    );
    await expect(page.locator(".transcript-composer__working")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await working.evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe(
      "transcript-composer-progress",
    );
    await stable();
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(workingBox.y + workingBox.height).toBeLessThanOrEqual(inputBox.y);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.screenshot({ path: `test-results/composer-working-${width}.png` });
    await input.fill("Hello");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await stable();
    await page.getByRole("button", { name: "Follow-up behavior" }).click();
    await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await stable();
    await input.fill(Array.from({ length: 30 }, () => "Draft line").join("\n"));
    const expanded = await height();
    expect(expanded).toBeGreaterThan(initial);
    expect(await input.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(240);
    expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect
      .poll(() => page.locator(".voice-dock").evaluate((el) => el.getBoundingClientRect().height))
      .toBe(expanded);
    await page.screenshot({ path: `test-results/composer-multiline-${width}.png` });
    await input.fill("");
    await stable();
    view.agentControls!.active = false;
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await stable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/composer-idle-${width}.png` });
  });
}
