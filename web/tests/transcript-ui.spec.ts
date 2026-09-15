import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/transcript-ui.html");
});

test("compiled transcript styles do not reset the host", async ({ page }) => {
  const marker = page.locator("#host-marker");
  await expect(marker).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(marker).toHaveCSS("margin", "17px");
  await expect(marker).toHaveCSS("font-family", "serif");
});

test("windowing keeps a bounded DOM for a 2,000-message transcript", async ({ page }) => {
  await page.evaluate(() => {
    const host = (
      window as unknown as Window & {
        transcriptFixture: {
          setWindowed(value: boolean): void;
          setMessages(messages: unknown[]): void;
        };
      }
    ).transcriptFixture;
    host.setWindowed(true);
    host.setMessages(
      Array.from({ length: 2_000 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant",
        content: `Message ${index}. ${"Variable transcript content. ".repeat((index % 5) + 1)}`,
        status: "complete",
      })),
    );
  });
  await expect(page.getByText("Message 1999.", { exact: false })).toBeVisible();
  expect(await page.locator("[data-windowed-row-key]").count()).toBeLessThan(40);
});

test("settled activity events retain the measured row and following message", async ({ page }) => {
  await page.evaluate(() => {
    const host = (
      window as unknown as Window & {
        transcriptFixture: {
          setWindowed(value: boolean): void;
          setDetail(value: "full"): void;
          setMessages(messages: unknown[]): void;
        };
      }
    ).transcriptFixture;
    host.setWindowed(true);
    host.setDetail("full");
    host.setMessages([
      { id: "before", role: "assistant", content: "Before activity", status: "complete" },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `command-${index}`,
        role: "tool",
        content: `command ${index}`,
        status: "complete",
        toolActivity: {
          name: "Command",
          detail: `command ${index}`,
          state: "complete",
          sections: [{ label: "Output", content: `Output ${index}` }],
        },
      })),
      { id: "after", role: "assistant", content: "After activity", status: "complete" },
    ]);
  });
  const group = page.locator(".activity-group__trigger");
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const items = page.locator(".activity-group__items");
  await expect(items.locator(":scope > *")).toHaveCount(5);
  for (const type of ["transitionend", "animationend"]) {
    await items.evaluate((element, eventType) => {
      element.dispatchEvent(new Event(eventType, { bubbles: true }));
    }, type);
    await expect
      .poll(() =>
        group.evaluate((element) => {
          const row = element.closest("[data-windowed-row-key]")!;
          const last = row.querySelector(".activity-group__items")!.lastElementChild!;
          return (
            row.nextElementSibling!.getBoundingClientRect().top -
            last.getBoundingClientRect().bottom
          );
        }),
      )
      .toBeGreaterThanOrEqual(0);
  }
});
