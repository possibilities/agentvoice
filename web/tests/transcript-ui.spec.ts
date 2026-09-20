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

test("Human, Agent and generic Tool bodies fill the wide transcript column", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator("main").evaluate((element) => {
    element.style.height = "950px";
  });
  await page.evaluate(() => {
    (
      window as unknown as Window & {
        transcriptFixture: { setMessages(messages: unknown[]): void };
      }
    ).transcriptFixture.setMessages([
      {
        id: "wide-human",
        role: "user",
        status: "complete",
        content: `Human ${"prose across the available transcript width. ".repeat(8)}`,
      },
      {
        id: "wide-agent",
        role: "assistant",
        status: "complete",
        content: `Agent ${"prose across the available transcript width. ".repeat(8)}`,
      },
      {
        id: "wide-tool",
        role: "tool",
        status: "complete",
        content: "",
        toolActivity: {
          name: "Command",
          detail: "wide output",
          state: "complete",
          sections: [
            {
              label: "Output",
              content: `Tool ${"content across the available transcript width. ".repeat(8)}`,
            },
          ],
        },
      },
    ]);
  });

  const human = page.locator('[data-slot="message"][data-role="user"] .markdown-content p');
  const agent = page.locator('[data-slot="message"][data-role="assistant"] .markdown-content p');
  const tool = page.locator('.tool-disclosure[data-transcript-type="tool-call"]');
  await tool.getByRole("button").click();
  const output = tool.getByLabel("Output", { exact: true });

  for (const body of [human, agent, output]) {
    const geometry = await body.evaluate((element) => {
      const container = element.closest(
        element.matches("pre") ? ".tool-detail" : ".markdown-content",
      );
      if (!container) throw new Error("Missing transcript body container");
      return {
        width: element.getBoundingClientRect().width,
        available: container.getBoundingClientRect().width,
      };
    });
    expect(geometry.width).toBeGreaterThan(900);
    expect(Math.abs(geometry.available - geometry.width)).toBeLessThan(2);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/full-width-transcript.png", fullPage: true });
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

test("settled activity disclosures remain separate measured rows", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1600 });
  await page.locator("main").evaluate((element) => {
    element.style.height = "1500px";
  });
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
  const triggers = page.locator(".tool-disclosure__trigger");
  await expect(triggers).toHaveCount(5);
  for (const trigger of await triggers.all()) await trigger.click();
  await expect(page.getByLabel(/Output/, { exact: true })).toHaveCount(5);
  await expect(page.locator(".activity-group")).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator("[data-windowed-row-key]").evaluateAll((rows) =>
        rows.slice(0, -1).every((row, index) => {
          const current = row.getBoundingClientRect();
          const next = rows[index + 1]!.getBoundingClientRect();
          return current.bottom <= next.top + 1;
        }),
      ),
    )
    .toBe(true);
});
