import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/transcript-ui.html");
  await page.evaluate(() => {
    (
      window as unknown as Window & {
        transcriptFixture: { setWindowed(value: boolean): void };
      }
    ).transcriptFixture.setWindowed(true);
  });
});

function command(id: string, state: "running" | "complete" | "error" = "complete") {
  return {
    id,
    role: "tool",
    content: "",
    status: state === "running" ? "working" : state,
    toolActivity: {
      name: "Command",
      detail: `run ${id}`,
      state,
      sections: [{ label: "Output", content: `${id} output` }],
    },
  };
}

function routing(id: string, revision: number) {
  return {
    id,
    role: "system",
    status: "complete",
    content: "Routing context updated.",
    nativeItemType: "agentusage.routing_context",
    routingContext: {
      generation: 1,
      revision,
      mode: revision === 1 ? "full" : "delta",
      current: revision === 1 ? { model: "gpt-5.6-sol", effort: "medium" } : undefined,
    },
  };
}

test("compact activity summary expands Tool blocks under one header divider", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  const messages = [
    { id: "before", role: "assistant", content: "Before activity", status: "complete" },
    command("command-ok"),
    {
      id: "files",
      role: "tool",
      status: "complete",
      content: "",
      nativeItemType: "fileChange",
      toolActivity: { name: "Files", detail: "2 files", state: "complete" },
      fileChanges: [
        {
          path: "/work/src/one.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          diffTruncated: false,
        },
        {
          path: "/work/src/two.ts",
          kind: "add",
          diff: "created\n",
          diffTruncated: false,
        },
      ],
    },
    routing("routing-1", 1),
    routing("routing-2", 2),
    command("command-failed", "error"),
    { id: "after", role: "assistant", content: "After activity", status: "complete" },
  ];
  await page.evaluate((value) => {
    (
      window as unknown as Window & {
        transcriptFixture: { setMessages(messages: unknown[]): void };
      }
    ).transcriptFixture.setMessages(value);
  }, messages);

  const group = page.locator(".activity-group");
  const trigger = group.locator(".activity-group__trigger");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toContainText("4 activities");
  await expect(trigger).toContainText("2 commands · 1 change set · 1 routing context");
  await expect(trigger).toContainText("1 failed");
  await expect(trigger).toContainText("2 file changes");
  await expect(group.locator('.tool-disclosure[data-transcript-type="tool-call"]')).toHaveCount(0);
  await expect(group.getByRole("separator")).toHaveCount(0);
  expect(
    await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderBottomWidth: style.borderBottomWidth,
        textDecorationLine: style.textDecorationLine,
        boxShadow: style.boxShadow,
      };
    }),
  ).toEqual({ borderBottomWidth: "0px", textDecorationLine: "none", boxShadow: "none" });

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const tools = group.locator('.tool-disclosure[data-transcript-type="tool-call"]');
  await expect(tools).toHaveCount(4);
  await expect(group.getByRole("separator")).toHaveCount(1);
  await expect(group.getByRole("separator")).toBeVisible();
  expect(
    await tools.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderBottomWidth),
    ),
  ).toEqual(["0px", "0px", "0px", "0px"]);
  await expect(group.locator("hr")).toHaveCount(0);

  const commandRow = tools.filter({ hasText: "run command-ok" });
  await commandRow.getByRole("button").click();
  await expect(commandRow.getByLabel("Output", { exact: true })).toHaveText("command-ok output");
  const fileRow = tools.filter({ hasText: "File change" });
  await fileRow.getByRole("button").first().click();
  await expect(fileRow.getByText("/work/src/one.ts", { exact: true })).toBeVisible();
  const routingRow = tools.filter({ hasText: "Routing context" });
  await routingRow.getByRole("button").click();
  await expect(routingRow.getByLabel("Routing update 2", { exact: true })).toBeVisible();

  await trigger.focus();
  await trigger.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(group.getByRole("separator")).toHaveCount(0);
  await expect(group.locator('.tool-disclosure[data-transcript-type="tool-call"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("activity-collapsed-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trigger).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("activity-collapsed-mobile.png") });
});

test("live tail growth preserves group focus, disclosure state, scroll pinning, and measurement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 520 });
  await page.locator("main").evaluate((element) => {
    element.style.height = "500px";
  });
  const lead = Array.from({ length: 80 }, (_, index) => ({
    id: `lead-${index}`,
    role: "assistant",
    content: `Earlier message ${index}. ${"Transcript history. ".repeat(3)}`,
    status: "complete",
  }));
  const update = async (tail: unknown[]) => {
    await page.evaluate(
      ({ before, after }) => {
        (
          window as unknown as Window & {
            transcriptFixture: { setMessages(messages: unknown[]): void };
          }
        ).transcriptFixture.setMessages([...before, ...after]);
      },
      { before: lead, after: tail },
    );
  };

  await update([command("tail-1", "running"), command("tail-2")]);
  const viewport = page.getByRole("region", { name: "Component transcript" });
  const group = page.locator(".activity-group");
  const trigger = group.locator(".activity-group__trigger");
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(64);
  await expect(group.locator(".tool-disclosure").last()).toBeInViewport();

  const firstTool = group.locator(".tool-disclosure").filter({ hasText: "run tail-1" });
  await firstTool.getByRole("button").click();
  await expect(firstTool.getByLabel("Output", { exact: true })).toBeVisible();
  await trigger.focus();
  await group.evaluate((element) => element.setAttribute("data-retained", "yes"));

  await update([command("tail-1"), command("tail-2"), command("tail-3", "running")]);
  await expect(group).toHaveAttribute("data-retained", "yes");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toContainText("3 activities");
  await expect(trigger).toContainText("1 running");
  await expect(group.locator(".tool-disclosure")).toHaveCount(3);
  await expect(firstTool.getByRole("button")).toHaveAttribute("aria-expanded", "true");

  await update([
    command("tail-1"),
    command("tail-2"),
    command("tail-3"),
    { id: "after-tail", role: "assistant", content: "After settled activity", status: "complete" },
  ]);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("After settled activity", { exact: true })).toBeInViewport();
  await expect
    .poll(() =>
      group.evaluate((element) => {
        const row = element.closest<HTMLElement>("[data-windowed-row-key]");
        const next = row?.nextElementSibling as HTMLElement | null;
        const last = element.querySelector<HTMLElement>(".activity-group__items > :last-child");
        if (!row || !next || !last) return -1;
        return Math.min(next.getBoundingClientRect().top - last.getBoundingClientRect().bottom, 1);
      }),
    )
    .toBeGreaterThanOrEqual(0);
  expect(await page.locator("[data-windowed-row-key]").count()).toBeLessThan(40);
});
