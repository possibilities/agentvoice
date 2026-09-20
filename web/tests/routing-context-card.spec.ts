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
          account: "codex-1",
          lane: "primary",
          usedPercent: 100 - remaining,
          resetsAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  };
}

test("routing refreshes share one activity disclosure with exact auditable updates", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  const setMessages = (messages: TranscriptMessage[]) =>
    page.evaluate((value) => {
      (
        window as unknown as { transcriptFixture: { setMessages(value: unknown[]): void } }
      ).transcriptFixture.setMessages(value);
    }, messages);
  const first = {
    ...routing("routing-1", 1, 72),
    routingContext: {
      ...routing("routing-1", 1, 72).routingContext!,
      balances: [
        ...routing("routing-1", 1, 72).routingContext!.balances!,
        {
          provider: "Codex" as const,
          account: "codex-1",
          lane: "weekly",
          usedPercent: 14,
          resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  };
  await setMessages([first]);
  const activity = page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Routing context",
  });
  await expect(activity).toContainText("gpt-5.6-sol · medium");
  await expect(activity).toContainText("1 update");
  await activity.evaluate((element) => element.setAttribute("data-retained", "yes"));

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
  const group = page.locator(".activity-group__trigger");
  await expect(group).toContainText("2 activities");
  await expect(group).toContainText("1 routing context · 1 command");
  await group.evaluate((element) => element.setAttribute("data-retained", "yes"));
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
  await expect(group).toHaveAttribute("data-retained", "yes");
  await group.focus();
  await group.press("Enter");
  await expect(activity).toHaveCount(1);
  await expect(activity).toContainText("2 updates");
  await activity.getByRole("button").focus();
  await activity.getByRole("button").press("Enter");
  await expect(activity.getByLabel("Routing update 2", { exact: true })).toContainText(
    '"usedPercent": 32',
  );
  await expect(activity.getByLabel("Routing update 1", { exact: true })).toContainText(
    '"lane": "weekly"',
  );
  await expect(page.locator(".message-author")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Command pwd", exact: true })).toBeVisible();

  await setMessages([
    first,
    routing("routing-2", 2, 68),
    { id: "human", role: "user", content: "Continue", status: "complete" },
    routing("routing-3", 3, 64),
  ]);
  const routingActivities = page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Routing context",
  });
  await expect(routingActivities).toHaveCount(2);
  await expect(routingActivities.nth(1)).toContainText("gpt-5.6-sol · medium");
  await page.screenshot({ path: "test-results/routing-context-activity.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Component transcript", exact: true })
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/routing-context-activity-narrow.png",
    fullPage: true,
  });
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
    await viewport.focus();
    await expect
      .poll(async () => {
        await viewport.press("Home");
        return viewport.evaluate((element) => element.scrollTop);
      })
      .toBeLessThan(2);
  };
  await scrollToStart();
  const activity = page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Routing context",
  });
  await expect(activity).toBeVisible();
  await activity.getByRole("button").click();
  await viewport.focus();
  await viewport.press("End");
  await expect(activity).toHaveCount(0);
  await scrollToStart();
  await expect(activity).toBeVisible();
  await setMessages(messages.map((message) => ({ ...message })));
  await expect(activity).toBeVisible();
  await expect(activity.getByRole("button")).toHaveAttribute("aria-expanded", "true");
});
