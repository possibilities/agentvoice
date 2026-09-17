import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../src/transcript-ui/transcript/index.ts";

function routing(id: string, revision: number, remaining: number): TranscriptMessage {
  return {
    id,
    role: "system",
    status: "complete",
    content: "Routing context updated.",
    nativeItemType: "agentusage.routing_context",
    routingContext: {
      generation: 2,
      revision,
      mode: revision === 1 ? "full" : "delta",
      current: revision === 1 ? { model: "gpt-5.6-sol", effort: "medium" } : undefined,
      balances: [
        {
          provider: "Codex",
          lane: "primary",
          remainingPercent: remaining,
          resetsAt: "2026-09-18T00:00:00.000Z",
        },
      ],
    },
  };
}

test("routing refreshes share one quiet card with newest balance and auditable updates", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  const setMessages = (messages: TranscriptMessage[]) =>
    page.evaluate((value) => {
      (
        window as unknown as { transcriptFixture: { setMessages(value: unknown[]): void } }
      ).transcriptFixture.setMessages(value);
    }, messages);
  const first = routing("routing-1", 1, 72);
  await setMessages([first]);
  const card = page.getByRole("note", { name: "Routing context", exact: true });
  await expect(card).toContainText("gpt-5.6-sol · medium");
  await expect(card).toContainText("72% remaining");
  await card.evaluate((element) => element.setAttribute("data-retained", "yes"));

  await setMessages([
    { ...first },
    {
      id: "tool",
      role: "tool",
      content: "ordinary tool",
      status: "complete",
      toolActivity: { name: "Command", detail: "pwd", state: "complete" },
    },
    routing("routing-2", 2, 68),
  ]);
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-retained", "yes");
  await expect(card).toContainText("68% remaining");
  await expect(card.getByRole("button", { name: "2 updates", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "2 updates", exact: true }).click();
  await expect(card).toContainText("Generation 2, revision 2 · delta");
  await expect(card).toContainText("Generation 2, revision 1 · full");
  await expect(page.locator(".message-author")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Command pwd", exact: true })).toBeVisible();

  await setMessages([
    first,
    routing("routing-2", 2, 68),
    { id: "human", role: "user", content: "Continue", status: "complete" },
    routing("routing-3", 3, 64),
  ]);
  await expect(page.getByRole("note", { name: "Routing context" })).toHaveCount(2);
  await expect(page.getByRole("note", { name: "Routing context" }).nth(1)).toContainText(
    "gpt-5.6-sol · medium",
  );
  await page.screenshot({ path: "test-results/routing-context-card.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Component transcript", exact: true })
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/routing-context-card-narrow.png", fullPage: true });
});

test("routing rollups survive history replacement and virtualization", async ({ page }) => {
  await page.goto("/tests/transcript-ui.html");
  const messages: TranscriptMessage[] = [
    routing("routing-1", 1, 72),
    routing("routing-2", 2, 68),
    ...Array.from({ length: 300 }, (_, index) => ({
      id: `after-${index}`,
      role: "assistant" as const,
      content: `After ${index}. ${"Transcript text. ".repeat(8)}`,
      status: "complete" as const,
    })),
  ];
  const setMessages = (value: TranscriptMessage[]) =>
    page.evaluate((next) => {
      const fixture = (
        window as unknown as {
          transcriptFixture: {
            setMessages(value: unknown[]): void;
            setWindowed(value: boolean): void;
          };
        }
      ).transcriptFixture;
      fixture.setWindowed(true);
      fixture.setMessages(next);
    }, value);
  await setMessages(messages);
  const viewport = page.getByRole("region", { name: "Component transcript", exact: true });
  const scrollToStart = async () => {
    await viewport.hover();
    await page.mouse.wheel(0, -10);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  };
  await scrollToStart();
  const card = page.getByRole("note", { name: "Routing context", exact: true });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "2 updates", exact: true }).click();
  await viewport.focus();
  await viewport.press("End");
  await expect(card).toHaveCount(0);
  await scrollToStart();
  await expect(card).toBeVisible();
  await setMessages(messages.map((message) => ({ ...message })));
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Hide updates", exact: true })).toBeVisible();
});
