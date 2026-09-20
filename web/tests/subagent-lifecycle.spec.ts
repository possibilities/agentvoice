import { expect, test } from "@playwright/test";
import { mapCodexSubagentEvent } from "../src/transcript-ui/lib/api/codex-subagent-event.ts";
import { contextCompactionMessage } from "../src/transcript-ui/lib/system-events.ts";
import type { LiveView } from "../src/types.ts";

function event(id: string, kind: string, path = "/root/review") {
  return {
    id,
    ...mapCodexSubagentEvent({ id, kind, agentPath: path, agentThreadId: "child-thread" })!,
  };
}
const cards = [
  event("start", "started"),
  event("end", "completed"),
  event("interrupt", "interrupted"),
];

test("lifecycle cards show exact events quietly and expose native identity by keyboard", async ({
  page,
}) => {
  const view: LiveView = {
    id: "lifecycle",
    phase: "live",
    agent: cards,
    voice: [],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const pane = page.getByRole("region", { name: "Agent", exact: true });
  for (const title of [
    "Subagent started",
    "Subagent turn completed",
    "Subagent interruption requested",
  ]) {
    await expect(pane.getByRole("note", { name: title, exact: true })).toBeVisible();
  }
  await expect(pane.locator(".message-author")).toHaveCount(0);
  await expect(pane.locator(".activity-group__trigger")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Voice", exact: true })).toHaveCount(0);
  const start = pane.getByRole("note", { name: "Subagent started", exact: true });
  await expect(start.getByText("/root/review", { exact: true })).toBeVisible();
  await expect(start.getByText("@/root/review", { exact: true })).toHaveCount(0);
  await expect(start.getByText("child-thread", { exact: true })).toHaveCount(0);
  const disclosure = start.getByRole("button", { name: "Details", exact: true });
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(start.getByText("child-thread", { exact: true })).toBeVisible();
  await expect(start.getByRole("button", { name: "Hide details" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect
    .poll(async () => {
      const current = await start.boundingBox();
      const next = await pane
        .getByRole("note", { name: "Subagent turn completed", exact: true })
        .boundingBox();
      return current && next ? next.y - (current.y + current.height) : -1;
    })
    .toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: "test-results/subagent-lifecycle.png", fullPage: true });
});

test("long agent paths wrap, disclosure survives polls, and compaction stays intact", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  const path = `/root/${"long_agent_name_".repeat(18)}/review`;
  const initial = event("long", "started", path);
  const setMessages = (messages: unknown[]) =>
    page.evaluate((value) => {
      (
        window as unknown as { transcriptFixture: { setMessages(value: unknown[]): void } }
      ).transcriptFixture.setMessages(value);
    }, messages);
  await page.setViewportSize({ width: 390, height: 844 });
  await setMessages([initial, { id: "compact", ...contextCompactionMessage(true) }]);
  const note = page.getByRole("note", { name: "Subagent started", exact: true });
  await note.getByRole("button", { name: "Details", exact: true }).click();
  await note.evaluate((el) => el.setAttribute("data-retained", "yes"));
  await setMessages([
    { ...initial },
    { id: "compact", ...contextCompactionMessage(true) },
    event("later", "completed"),
  ]);
  await expect(note).toHaveAttribute("data-retained", "yes");
  await expect(note.getByText("child-thread", { exact: true })).toBeVisible();
  await expect(page.getByRole("note", { name: "Context compacted" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dimensions = await note.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({ path: "test-results/subagent-lifecycle-narrow.png", fullPage: true });
});

test("a lifecycle card keeps its row identity and disclosure state across virtualization", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  const lifecycle = event("retained-completion", "completed", "/root/persistent_worker");
  const messages = [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `before-${index}`,
      role: "assistant",
      content: `Before ${index}. ${"Transcript text. ".repeat(8)}`,
      status: "complete",
    })),
    lifecycle,
    ...Array.from({ length: 300 }, (_, index) => ({
      id: `after-${index}`,
      role: "assistant",
      content: `After ${index}. ${"Transcript text. ".repeat(8)}`,
      status: "complete",
    })),
  ];
  const setMessages = (value: unknown[]) =>
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
  };
  await scrollToStart();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  const card = page.getByRole("note", { name: "Subagent turn completed", exact: true });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Details", exact: true }).click();
  await expect(card.getByText("child-thread", { exact: true })).toBeVisible();

  await viewport.focus();
  await viewport.press("End");
  await expect(card).toHaveCount(0);
  await setMessages([
    ...messages.map((message) => ({ ...message })),
    {
      id: "latest",
      role: "assistant",
      content: "Latest transcript message",
      status: "complete",
    },
  ]);
  await scrollToStart();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Hide details", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(card.getByText("child-thread", { exact: true })).toBeVisible();
});
