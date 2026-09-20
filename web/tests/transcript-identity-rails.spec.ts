import { expect, type Page, test } from "@playwright/test";
import type { Message } from "../src/transcript-ui/types/message";

const createdAt = "2026-09-20T14:30:00.000Z";
const voice: Message = {
  id: "voice",
  role: "user",
  status: "complete",
  createdAt,
  content: "Original voice envelope",
  presentation: {
    title: "Via Voice",
    body: "Review the release.",
    details: [{ label: "Voice context", content: "Human asked for release review." }],
  },
};
const command: Message = {
  id: "command",
  role: "tool",
  status: "error",
  content: "Command failed",
  createdAt,
  toolActivity: {
    name: "Command",
    detail: "bun run test",
    state: "error",
    sections: [{ label: "Output", content: "One failing check" }],
  },
};
const messages: Message[] = [
  {
    id: "human",
    role: "user",
    status: "complete",
    createdAt,
    content: "Please review this change.",
  },
  {
    id: "agent",
    role: "assistant",
    status: "complete",
    createdAt,
    content: "I’ll check the implementation and its behavior.",
  },
  voice,
  command,
  {
    id: "files",
    role: "tool",
    status: "working",
    content: "",
    toolActivity: { name: "Files", detail: "Reviewing files", state: "running" },
    fileChanges: [
      {
        path: "/work/src/app.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new",
        diffTruncated: false,
      },
    ],
  },
  {
    id: "routing",
    role: "system",
    nativeItemType: "agentusage.routing_context",
    status: "complete",
    content: "Routing update",
    routingContext: {
      generation: 1,
      revision: 1,
      mode: "full",
      current: { model: "gpt-5.6-sol", effort: "medium" },
    },
  },
  {
    id: "compaction",
    role: "system",
    nativeItemType: "contextCompaction",
    status: "working",
    content: "Compacting context",
  },
  {
    id: "status",
    role: "system",
    nativeItemType: "status",
    status: "complete",
    content: "Connection restored",
  },
  {
    id: "lifecycle",
    role: "system",
    nativeItemType: "subAgentActivity",
    status: "complete",
    content: "Lifecycle must stay hidden",
  },
];

async function setMessages(page: Page, entries: Message[], windowed = false, follow = true) {
  await page.evaluate(
    ({ entries, windowed, follow }) => {
      const fixture = (
        window as unknown as {
          transcriptFixture: {
            setMessages(messages: Message[]): void;
            setWindowed(value: boolean): void;
            setFollow(value: boolean): void;
          };
        }
      ).transcriptFixture;
      fixture.setFollow(follow);
      fixture.setWindowed(windowed);
      fixture.setMessages(entries);
    },
    { entries, windowed, follow },
  );
}

for (const width of [1440, 800, 390, 320]) {
  test(`identity rails preserve reading edges and complete disclosures at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/tests/transcript-ui.html");
    await page.locator("main").evaluate((element) => {
      element.style.height = "1000px";
    });
    await setMessages(page, messages);
    const rows = page.locator(".identity-row");
    await expect(page.locator(".message-author, [data-slot=message-header]")).toHaveCount(0);
    for (const name of ["Human", "Agent", "Human via Voice", "Tool activities"]) {
      await expect(page.getByRole("img", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("img", { name: "Human", exact: true })).toHaveAccessibleDescription(
      /2026/,
    );
    await expect(page.locator(".identity-row__mark time").first()).toHaveAttribute(
      "datetime",
      createdAt,
    );
    await expect(page.locator(".identity-row__mark time").first()).toBeHidden();
    const geometry = await rows.evaluateAll((elements) =>
      elements.slice(0, 3).map((row) => {
        const body = row.querySelector(".markdown-content")!;
        const icon = row.querySelector(".identity-row__mark svg")!;
        const content = row.querySelector('[data-slot="message-content"]')!;
        const style = getComputedStyle(content);
        return {
          x: body.getBoundingClientRect().x,
          center: icon.getBoundingClientRect().y + 8 - body.getBoundingClientRect().y,
          background: getComputedStyle(row).backgroundColor,
          border: getComputedStyle(row).borderLeftWidth,
          width: body.getBoundingClientRect().width,
          available:
            content.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight) -
            parseFloat(style.borderLeftWidth),
        };
      }),
    );
    for (const row of geometry) {
      expect(Math.abs(row.x - geometry[0]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.center - 14)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.width - row.available)).toBeLessThanOrEqual(1);
    }
    expect(geometry[0]!.border).toBe("2px");
    expect(geometry[2]!.border).toBe("2px");
    expect(geometry[0]!.background).toBe(geometry[2]!.background);
    expect(geometry[1]!.background).toBe("rgba(0, 0, 0, 0)");
    const bulletGeometry = await rows.evaluateAll((elements) =>
      elements.map((row) => {
        const icon = row.querySelector(".identity-row__mark svg")!.getBoundingClientRect();
        const text = row
          .querySelector(".markdown-content, .activity-group__count, .tool-disclosure__name")!
          .getBoundingClientRect();
        return { icon: icon.x, text: text.x, gap: text.x - icon.right };
      }),
    );
    for (const geometry of bulletGeometry) {
      expect(Math.abs(geometry.icon - bulletGeometry[0]!.icon)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.text - bulletGeometry[0]!.text)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.gap - 8)).toBeLessThanOrEqual(1);
    }
    const humanSurfaces = await page
      .locator('.identity-row:is([data-identity="human"], [data-identity="voice"])')
      .evaluateAll((elements) =>
        elements.map((row) => {
          const surface = row.getBoundingClientRect();
          return [
            ...row.querySelectorAll(".identity-row__mark svg, .voice-message-modal__trigger"),
          ].every((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= surface.left &&
              rect.right <= surface.right &&
              rect.top >= surface.top &&
              rect.bottom <= surface.bottom
            );
          });
        }),
      );
    expect(humanSurfaces).toEqual([true, true]);
    const inspect = page.getByRole("button", { name: "Open voice message details" });
    const target = await inspect.boundingBox();
    expect(target?.width).toBe(width <= 640 ? 44 : 28);
    expect(target?.height).toBe(width <= 640 ? 44 : 28);
    await expect(inspect).not.toHaveAttribute("title");
    const group = page.locator(".activity-group__trigger");
    await expect(group).toContainText("3 activities");
    await expect(group).toContainText("1 command · 1 change set · 1 routing context");
    await expect(group).toContainText("1 failed");
    await expect(group).toContainText("1 running");
    await expect(group).toContainText("1 file change");
    await page.screenshot({
      path: `test-results/identity-rails-${width}-collapsed.png`,
      fullPage: true,
    });
    await group.focus();
    await group.press("Enter");
    await expect(group).toHaveAttribute("aria-expanded", "true");
    const child = page.locator(".activity-group__items .tool-disclosure__trigger").first();
    await child.press("Space");
    await expect(page.getByLabel("Output", { exact: true })).toBeVisible();
    const activityGroup = page.locator(".activity-group");
    const items = activityGroup.locator(".activity-group__items");
    await expect(items.locator(".tool-disclosure")).toHaveCount(3);
    await expect(
      activityGroup.getByRole("img", { name: "Tool activities", exact: true }),
    ).toHaveCount(1);
    await expect(activityGroup.locator(".identity-row__mark svg")).toHaveCount(1);
    await expect(activityGroup.locator(".identity-row")).toHaveCount(1);
    await expect(activityGroup.locator(".identity-row__actions")).toHaveCount(1);
    await expect(
      items.locator(".identity-row, .identity-row__mark, .identity-row__actions"),
    ).toHaveCount(0);
    await expect(items.getByRole("img", { name: "Tool", exact: true })).toHaveCount(0);
    await expect(child).toHaveAccessibleDescription(/2026/);
    const standalone = page.locator(".tool-disclosure").filter({ hasText: "Compacting context" });
    await expect(standalone.getByRole("img", { name: "Tool", exact: true })).toHaveCount(1);
    const alignment = await activityGroup.evaluate((element) => {
      const header = element.querySelector(".activity-group__trigger")!.getBoundingClientRect();
      return [...element.querySelectorAll(".activity-group__items .tool-disclosure__trigger")].map(
        (trigger) => {
          const rect = trigger.getBoundingClientRect();
          return {
            left: rect.left - header.left,
            right: rect.right - header.right,
            width: rect.width - header.width,
          };
        },
      );
    });
    for (const bounds of alignment) {
      expect(Math.abs(bounds.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.width)).toBeLessThanOrEqual(1);
    }
    for (const tool of await page.locator(".tool-disclosure").all())
      await expect(tool).toHaveCSS("border-bottom-width", "0px");
    await expect(group).toHaveCSS("text-decoration-line", "none");
    await group.press("Space");
    await expect(child).toHaveCount(0);
    await expect(group).toBeFocused();
    await setMessages(page, [...messages, { ...command, id: "later", status: "complete" }]);
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await group.press("Enter");
    await expect(page.getByLabel("Output", { exact: true })).toBeVisible();
    await expect(page.getByText("Lifecycle must stay hidden")).toHaveCount(0);
    await expect(page.locator('.activity-group__items [data-state="running"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/identity-rails-${width}-expanded.png`,
      fullPage: true,
    });
    await inspect.click();
    const dialog = page.getByRole("dialog", { name: "Voice message details" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Human asked for release review.")).toBeVisible();
    await expect(dialog.getByText("Original voice envelope")).toBeVisible();
    await expect(dialog.locator("time")).toHaveAttribute("datetime", createdAt);
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();
  });
}

test.describe("coarse pointer", () => {
  test.use({ hasTouch: true });
  test("desktop-sized touch targets remain 44px without shifting Human prose", async ({ page }) => {
    await page.goto("/tests/transcript-ui.html");
    await setMessages(page, [voice]);
    const action = page.getByRole("button", { name: "Open voice message details" });
    expect((await action.boundingBox())?.width).toBe(44);
    expect((await action.boundingBox())?.height).toBe(44);
    expect(
      await action.evaluate((element) => {
        const action = element.getBoundingClientRect();
        const surface = element.closest(".identity-row")!.getBoundingClientRect();
        return (
          action.top >= surface.top &&
          action.bottom <= surface.bottom &&
          action.left >= surface.left &&
          action.right <= surface.right
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: "test-results/identity-rails-coarse.png" });
  });
});

test("long content and delivery truth wrap without page overflow at 200% scale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto("/tests/transcript-ui.html");
  await page.locator("#transcript-fixture").evaluate((element) => {
    element.style.zoom = "2";
  });
  await setMessages(page, [
    {
      id: "long",
      role: "user",
      status: "complete",
      pendingImageCount: 2,
      deliveryStatus: "Delivery outcome unknown; retain this message until native confirmation.",
      content: `A long link: https://example.test/${"long".repeat(50)}\n\n| Column | Value |\n| --- | --- |\n| Entry | Table content |\n\n\`\`\`ts\n${"const value = 1; ".repeat(20)}\n\`\`\``,
    },
  ]);
  await expect(page.getByRole("status")).toContainText("Delivery outcome unknown");
  await expect(page.getByRole("status")).toHaveCSS("white-space", "normal");
  await expect(page.getByText("2 images attached")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/identity-rails-zoom.png", fullPage: true });
});

test("windowing preserves a voice dialog and its focused opener across scroll", async ({
  page,
}) => {
  await page.goto("/tests/transcript-ui.html");
  await setMessages(
    page,
    [
      ...Array.from(
        { length: 200 },
        (_, index): Message => ({
          id: `history-${index}`,
          role: "assistant",
          status: "complete",
          content: `History ${index}. ${"Readable content. ".repeat(10)}`,
        }),
      ),
      voice,
    ],
    true,
    false,
  );
  const action = page.getByRole("button", { name: "Open voice message details" });
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await action.click();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText("History 0.", { exact: false })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Voice message details" })).toBeVisible();
  expect(await page.locator("[data-windowed-row-key]").count()).toBeLessThan(40);
  await page.keyboard.press("Escape");
  await expect(action).toBeFocused();
  await viewport.focus();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(action).toHaveCount(0);
});
