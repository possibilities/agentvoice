import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`composer divider communicates runtime state without moving the dock (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const view: LiveView = {
      id: "divider-fixture",
      persistenceScope: "divider-workspace-thread",
      phase: "live",
      agent: [
        { id: "a", role: "assistant", status: "complete", content: "A retained conversation." },
      ],
      voice: [],
      agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
    };
    await page.route("**/api/live", (route) => route.fulfill({ json: view }));
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Message Agent" });
    const line = page.locator(".transcript-composer__activity-line");
    const inputGroup = page.locator('[data-slot="input-group"]');
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await expect.poll(() => inputGroup.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await input.fill("Retain this draft through every connection state");
    const metrics = () =>
      line.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const segment = getComputedStyle(el, "::after");
        return {
          top: rect.top,
          height: rect.height,
          color: style.backgroundColor,
          animation: segment.animationName,
          opacity: segment.opacity,
        };
      });
    const idle = await metrics();
    expect(idle.height).toBeGreaterThanOrEqual(3);
    expect(idle.animation).toBe("none");
    const dock = await page.locator(".agent-dock").boundingBox();
    view.agentControls!.active = true;
    await expect(line).toHaveAttribute("data-active", "true");
    const working = await metrics();
    expect(working.top).toBe(idle.top);
    expect(working.height).toBe(idle.height);
    expect(working.opacity).toBe("1");
    expect(working.animation === "none").toBe(reducedMotion === "reduce");
    await page.screenshot({ path: `test-results/divider-working-${reducedMotion}.png` });

    view.agentControls!.active = false;
    view.agentNotice = "Agent transcript is catching up. Input remains available.";
    await expect(page.getByText(view.agentNotice, { exact: true })).toBeVisible();
    await expect(line).toHaveAttribute("data-reachable", "true");
    await expect.poll(async () => (await metrics()).color).toBe(idle.color);
    await expect(input).toHaveValue("Retain this draft through every connection state");
    await page.screenshot({ path: `test-results/divider-catching-up-${reducedMotion}.png` });

    // Retained activity can be stale: unavailable wins over a last-known active turn.
    view.phase = "unavailable";
    view.agentNotice = "Agent transcript disconnected. Reconnecting…";
    view.agentControls!.available = false;
    view.agentControls!.inputUnavailableReason =
      "Agent input is unavailable while the transcript reader reconnects. Your draft is still editable.";
    await expect(
      page.getByText(view.agentControls!.inputUnavailableReason, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(view.agentNotice, { exact: true })).toBeVisible();
    await expect.poll(() => inputGroup.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await expect.poll(async () => (await metrics()).animation).toBe("none");
    await expect.poll(async () => (await metrics()).color).not.toBe(idle.color);
    const unavailable = await metrics();
    expect(unavailable.top).toBe(idle.top);
    expect(unavailable.height).toBe(idle.height);
    await expect(input).toBeEditable();
    await page.screenshot({ path: `test-results/divider-unavailable-${reducedMotion}.png` });

    view.phase = "detached";
    view.agentControls!.available = true;
    view.agentControls!.inputUnavailableReason = undefined;
    view.agentNotice = undefined;
    view.agentControls!.active = false;
    await expect.poll(async () => (await metrics()).color).toBe(idle.color);
    expect((await metrics()).animation).toBe("none");
    await expect(input).toHaveValue("Retain this draft through every connection state");
    expect(await page.locator(".agent-dock").boundingBox()).toEqual(dock);
    await page.screenshot({ path: `test-results/divider-detached-${reducedMotion}.png` });
  });
}
