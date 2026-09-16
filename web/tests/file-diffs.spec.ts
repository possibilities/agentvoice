import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/transcript-ui.html");
});

test("file operations stay top-level and disclose ordered Pierre diffs and original detail", async ({
  page,
}) => {
  await page.evaluate(() => {
    const host = (
      window as unknown as Window & {
        transcriptFixture: { setMessages(messages: unknown[]): void };
      }
    ).transcriptFixture;
    const command = (id: string) => ({
      id,
      role: "tool",
      content: id,
      status: "complete",
      toolActivity: {
        name: "Command",
        detail: id,
        state: "complete",
        sections: [{ label: "Output", content: `${id} output` }],
      },
    });
    const original = {
      type: "fileChange",
      id: "patch",
      status: "completed",
      changes: ["new.ts", "edit.ts", "old.ts", "before.ts → after.ts"],
    };
    host.setMessages([
      command("prepare-1"),
      command("prepare-2"),
      {
        id: "files",
        role: "tool",
        content: "",
        status: "complete",
        nativeItemType: "fileChange",
        toolActivity: {
          name: "Files",
          detail: "4 files",
          meta: "completed",
          state: "complete",
          sections: [{ label: "Original record", content: JSON.stringify(original, null, 2) }],
        },
        fileChanges: [
          {
            path: "/work/src/new.ts",
            kind: "add",
            diff: "export const created = true;\n",
            diffTruncated: false,
          },
          {
            path: "/work/src/edit.ts",
            kind: "update",
            diff: "@@ -1,2 +1,2 @@\n const stable = true;\n-const value = 'old';\n+const value = 'new';\n",
            diffTruncated: true,
          },
          {
            path: "/work/src/old.ts",
            kind: "delete",
            diff: "export const obsolete = true;\n",
            diffTruncated: false,
          },
          {
            path: "/work/src/before.ts",
            movePath: "/work/src/after.ts",
            kind: "update",
            diff: "",
            diffTruncated: false,
          },
        ],
      },
      command("verify-1"),
      command("verify-2"),
    ]);
  });

  const card = page.locator(".file-change-event");
  await expect(card).toBeVisible();
  await expect(page.locator(".activity-group")).toHaveCount(2);
  await expect(page.locator(".activity-group .file-change-event")).toHaveCount(0);

  const cardTrigger = card.locator(":scope .tool-disclosure__trigger");
  await expect(cardTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(cardTrigger).toContainText("Edited");
  await expect(cardTrigger.getByLabel("2 lines added, 2 lines removed")).toBeVisible();

  const paths = card.locator(".file-disclosure__path");
  await expect(paths).toHaveCount(5);
  expect(await paths.allTextContents()).toEqual([
    "/work/src/new.ts",
    "/work/src/edit.ts",
    "/work/src/old.ts",
    "/work/src/before.ts → /work/src/after.ts",
    "Original details",
  ]);
  await expect(
    card.getByLabel("renamed file /work/src/before.ts → /work/src/after.ts: path only"),
  ).toBeDisabled();

  await card.getByLabel("Expand added file /work/src/new.ts").click();
  await card.getByLabel("Expand edited file /work/src/edit.ts").click();
  await card.getByLabel("Expand deleted file /work/src/old.ts").click();
  await expect(card.locator(".pierre-diff")).toHaveCount(3);
  await expect(
    card.getByText("This diff was truncated by the source.", { exact: false }),
  ).toBeVisible();

  const originalDetails = card.getByLabel("Expand original file operation details");
  await originalDetails.focus();
  await originalDetails.press("Enter");
  await expect(card.getByLabel("Original record", { exact: true })).toContainText('"id": "patch"');

  await page.locator("#host-marker").click();
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.locator("main").evaluate((element) => {
    element.style.height = "1500px";
  });
  await card.screenshot({ path: "test-results/file-diffs-card.png" });
  await page.setViewportSize({ width: 420, height: 1600 });
  await expect(paths.nth(3)).toBeVisible();
  await card.screenshot({ path: "test-results/file-diffs-card-narrow.png" });
});
