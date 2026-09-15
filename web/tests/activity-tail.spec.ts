import { expect, test } from "@playwright/test";

for (const count of [2, 5])
  test(`tail ${count} expands and grows without clipping`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lead = Array.from({ length: 80 }, (_, i) => ({
      id: `lead-${i}`,
      role: "assistant",
      content: `Earlier message ${i}\n\nSome text to fill the history.`,
      status: "complete",
    }));
    const command = (i: number) => ({
      id: `tool-${i}`,
      role: "tool",
      content: `command ${i}`,
      status: "complete",
      toolActivity: {
        name: "Command",
        detail: `command ${i}`,
        state: "complete",
        sections: [{ label: "Output", content: `Output ${i}` }],
      },
    });
    let view = {
      phase: "live",
      id: "tail-audit",
      persistenceScope: "tail-audit",
      voice: [],
      agent: [...lead, ...Array.from({ length: count }, (_, i) => command(i))],
    };
    await page.route("**/api/live", (r) => r.fulfill({ json: view }));
    await page.goto("/");
    const group = page.locator(".activity-group__trigger");
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "true");
    const children = page.locator(".activity-group__items > *");
    await expect(children).toHaveCount(count);
    const geometry = () =>
      children.evaluateAll((elements) =>
        elements.map((el) => {
          const r = el.getBoundingClientRect();
          const vp = el.closest('[data-slot="message-scroller-viewport"]')!.getBoundingClientRect();
          const panel = el.closest('[data-slot="collapsible-content"]')!.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return {
            bottom: r.bottom,
            top: r.top,
            viewportTop: vp.top,
            viewportBottom: vp.bottom,
            panelBottom: panel.bottom,
            hit: hit !== null && el.contains(hit),
          };
        }),
      );
    await expect
      .poll(async () => {
        const rows = await geometry();
        return rows.every(
          (g) =>
            g.top >= g.viewportTop &&
            g.bottom <= g.viewportBottom &&
            g.bottom <= g.panelBottom &&
            g.hit,
        );
      })
      .toBe(true);
    for (let n = count + 1; n <= count + 3; n++) {
      view = { ...view, agent: [...lead, ...Array.from({ length: n }, (_, i) => command(i))] };
      await expect(children).toHaveCount(n);
      await expect
        .poll(async () => {
          const rows = await geometry();
          return rows.every(
            (g) =>
              g.top >= g.viewportTop &&
              g.bottom <= g.viewportBottom &&
              g.bottom <= g.panelBottom &&
              g.hit,
          );
        })
        .toBe(true);
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("tail.png") });
  });
