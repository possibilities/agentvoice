import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../src/transcript-ui/transcript/index";

const initial: TranscriptMessage[] = [
  {
    id: "lead",
    role: "assistant",
    status: "complete",
    content: "Checking the build and file updates.",
  },
  {
    id: "plain",
    role: "tool",
    status: "complete",
    content: "",
    toolActivity: {
      name: "Command",
      detail: "pwd",
      state: "complete",
      sections: [{ label: "Output", content: "/work" }],
    },
  },
  {
    id: "long",
    role: "tool",
    status: "error",
    content: "",
    toolActivity: {
      name: "MCP · Inspect package and runtime configuration",
      detail: "The complete failure remains available below",
      meta: "Failed after checking workspace configuration and package metadata",
      state: "error",
      sections: [{ label: "Error", content: "The requested package was unavailable." }],
    },
  },
  {
    id: "files",
    role: "tool",
    status: "working",
    content: "",
    toolActivity: { name: "Files", detail: "1 file", meta: "in progress", state: "running" },
    fileChanges: [
      {
        path: "/work/src/components/example-with-a-long-file-name.tsx",
        kind: "update",
        diff: "@@ -1 +1 @@\n-before\n+after\n",
        diffTruncated: false,
      },
    ],
  },
  {
    id: "routing",
    role: "system",
    status: "complete",
    content: "Routing context updated",
    nativeItemType: "agentusage.routing_context",
    routingContext: {
      generation: 1,
      revision: 1,
      mode: "full",
      current: { model: "gpt-5.6-sol", effort: "medium" },
    },
  },
  {
    id: "routing-next",
    role: "system",
    status: "complete",
    content: "Routing context updated",
    nativeItemType: "agentusage.routing_context",
    routingContext: { generation: 1, revision: 2, mode: "delta", current: { effort: "high" } },
  },
];

for (const width of [1440, 390]) {
  test.describe(`activity rhythm at ${width}px`, () => {
    test.use({ viewport: { width, height: 1100 }, hasTouch: width < 640 });
    test("one expanded divider, tight child spacing and a shared trailing caret column", async ({
      page,
    }) => {
      await page.goto("/tests/transcript-ui.html");
      await page.locator("main").evaluate((element) => {
        element.style.height = "1000px";
      });
      const setMessages = (messages: TranscriptMessage[]) =>
        page.evaluate((messages) => {
          const fixture = (
            window as unknown as {
              transcriptFixture: {
                setFollow(value: boolean): void;
                setMessages(value: TranscriptMessage[]): void;
              };
            }
          ).transcriptFixture;
          fixture.setFollow(false);
          fixture.setMessages(messages);
        }, messages);
      await setMessages(initial);
      await page.evaluate(() => document.fonts.ready);
      const group = page.locator(".activity-group");
      const header = group.locator(".activity-group__trigger");
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(group.getByRole("separator")).toHaveCount(0);
      await expect(header).toHaveCSS("border-bottom-width", "0px");
      await expect(header).toHaveCSS("text-decoration-line", "none");
      const collapsedHeight = (await group.boundingBox())!.height;
      await page
        .locator("main")
        .screenshot({ path: `test-results/activity-rhythm-${width}-collapsed.png` });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await expect(header).toContainText("4 activities");
      await expect(group.locator(".activity-group__error")).toHaveText("1 failed");
      await expect(group.locator(".telemetry-live")).toHaveText("1 running");
      await expect(group.locator(".activity-group__files")).toHaveText("1 file change");
      const divider = group.getByRole("separator");
      await expect(divider).toHaveCount(1);
      await expect(divider).toBeVisible();
      await expect(divider).toHaveAttribute("data-orientation", "horizontal");
      await expect(group.locator(".identity-row__mark")).toHaveCount(1);
      const triggers = group.locator(".activity-group__items .tool-disclosure__trigger");
      await expect(triggers).toHaveCount(4);
      const geometry = () =>
        group.evaluate((element) => {
          const header = element.querySelector(".activity-group__trigger")!.getBoundingClientRect();
          const separator = element
            .querySelector(".activity-group__divider")!
            .getBoundingClientRect();
          const list = element.querySelector(".activity-group__items")!;
          const rows = [...list.querySelectorAll(":scope > [data-slot=collapsible]")].map((row) =>
            row.getBoundingClientRect(),
          );
          const triggers = [
            ...element.querySelectorAll(
              ".activity-group__trigger, .activity-group__items .tool-disclosure__trigger",
            ),
          ];
          return {
            divider: {
              height: separator.height,
              x: separator.x - header.x,
              width: separator.width - header.width,
              before: separator.top - header.bottom,
              after: rows[0]!.top - separator.bottom,
            },
            gaps: rows.slice(1).map((row, index) => row.top - rows[index]!.bottom),
            trailing: list.getBoundingClientRect().bottom - rows.at(-1)!.bottom,
            columns: triggers.map((trigger) => {
              const arrow = trigger
                .querySelector(":scope > .tool-disclosure__chevron")!
                .getBoundingClientRect();
              const rect = trigger.getBoundingClientRect();
              return {
                right: arrow.right - header.right,
                inset: rect.right - arrow.right,
                column: getComputedStyle(trigger).gridTemplateColumns.split(" ").at(-1),
                height: rect.height,
              };
            }),
            borders: [...list.querySelectorAll(".tool-disclosure")].map((row) => [
              getComputedStyle(row).borderTopWidth,
              getComputedStyle(row).borderBottomWidth,
            ]),
          };
        });
      await expect
        .poll(async () =>
          (await geometry()).columns.every(
            (column) => Math.abs(column.right) <= 1 && Math.abs(column.inset) <= 1,
          ),
        )
        .toBe(true);
      const layout = await geometry();
      expect(layout.divider.height).toBe(1);
      expect(Math.abs(layout.divider.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.divider.width)).toBeLessThanOrEqual(1);
      expect(layout.divider.before).toBeCloseTo(2, 1);
      expect(layout.divider.after).toBeCloseTo(4, 1);
      for (const gap of layout.gaps) expect(gap).toBeCloseTo(4, 1);
      expect(layout.trailing).toBeCloseTo(0, 1);
      expect(layout.borders).toEqual([
        ["0px", "0px"],
        ["0px", "0px"],
        ["0px", "0px"],
        ["0px", "0px"],
      ]);
      for (const column of layout.columns) {
        expect(column.column).toBe("16px");
        expect(column.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 36);
      }
      const meta = group.locator(".tool-disclosure__meta").filter({ hasText: "Failed after" });
      if (width > 640) await expect(meta).toBeVisible();
      else await expect(meta).toBeHidden();
      await page
        .locator("main")
        .screenshot({ path: `test-results/activity-rhythm-${width}-expanded.png` });
      await triggers.first().click();
      await expect(group.getByLabel("Output", { exact: true })).toHaveText("/work");
      await group.evaluate((element) => {
        element.setAttribute("data-retained", "yes");
      });
      await setMessages(
        initial.map((message) =>
          message.id === "plain"
            ? {
                ...message,
                status: "working",
                toolActivity: {
                  ...message.toolActivity!,
                  state: "running",
                  meta: "Working while checking the complete project configuration",
                },
              }
            : message,
        ),
      );
      await expect(group).toHaveAttribute("data-retained", "yes");
      await expect(group.locator(".telemetry-live")).toHaveText("2 running");
      await expect(triggers.first()).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(async () => (await geometry()).columns.every((column) => Math.abs(column.right) <= 1))
        .toBe(true);
      await expect(divider).toHaveCount(1);
      await header.focus();
      await header.press("Space");
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(header).toBeFocused();
      await expect(divider).toHaveCount(0);
      await expect
        .poll(async () => Math.abs((await group.boundingBox())!.height - collapsedHeight))
        .toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
}
