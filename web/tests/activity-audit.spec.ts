import { expect, test } from "@playwright/test";

for (const count of [2, 3, 5])
  test(`${count} expanded activities remain fully painted and do not overlap next message`, async ({
    page,
  }, testInfo) => {
    const tools = Array.from({ length: count }, (_, i) => ({
      id: `tool-${i}`,
      role: "tool",
      content: `command ${i + 1}`,
      status: "complete",
      toolActivity: {
        name: "Command",
        detail: `command ${i + 1}`,
        state: "complete",
        sections: [{ label: "Output", content: `Output ${i + 1}` }],
      },
    }));
    const lead = { id: "lead", role: "assistant", content: "Before activity", status: "complete" };
    const next = { id: "next", role: "assistant", content: "After activity", status: "complete" };
    let view = {
      phase: "live",
      id: `audit-${count}`,
      persistenceScope: `audit-${count}`,
      voice: [],
      agent: [lead, ...tools, next],
    };
    await page.route("**/api/live", (r) => r.fulfill({ json: view }));
    await page.goto("/");
    const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
    const group = agent.locator(".activity-group__trigger");
    await expect(group).toContainText(`${count} commands`);
    for (let cycle = 0; cycle < 3; cycle++) {
      await group.click();
      await expect(group).toHaveAttribute("aria-expanded", "true");
      const children = agent.locator(".activity-group__items > *");
      await expect(children).toHaveCount(count);
      await expect
        .poll(() =>
          group.evaluate((element) => {
            const row = element.closest("[data-windowed-row-key]")!;
            const next = row.nextElementSibling!;
            const last = row.querySelector(".activity-group__items")!.lastElementChild!;
            return next.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
          }),
        )
        .toBeGreaterThanOrEqual(0);
      for (let i = 0; i < count; i++) {
        const trigger = children.nth(i).locator(".tool-disclosure__trigger");
        await trigger.scrollIntoViewIfNeeded();
        await expect(trigger).toBeInViewport();
        expect(
          await trigger.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit !== null && el.contains(hit);
          }),
        ).toBe(true);
      }
      if (cycle === 0) {
        view = {
          ...view,
          agent: [lead, ...tools, { ...next, content: "Updated following activity after polling" }],
        };
        await expect(agent).toContainText("Updated following activity after polling");
        const last = children.last().locator(".tool-disclosure__trigger");
        await last.click();
        await expect(children.last().getByLabel("Output", { exact: true })).toHaveText(
          `Output ${count}`,
        );
        await last.click();
        await page.screenshot({ path: testInfo.outputPath(`${count}-expanded.png`) });
      }
      await group.click();
      await expect(group).toHaveAttribute("aria-expanded", "false");
    }
  });
