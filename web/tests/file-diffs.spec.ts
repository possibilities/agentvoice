import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/transcript-ui.html");
});

test("file operations use ordered attachments with Pierre diffs and original evidence", async ({
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

  const row = page.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "File change",
  });
  await expect(row).toBeVisible();
  await expect(page.locator(".tool-disclosure")).toHaveCount(5);
  await row.getByRole("button").first().click();
  await expect(row.locator(".tool-disclosure__summary")).toHaveText("Edited 4 files");
  await expect(row.locator('[data-slot="attachment"]')).toHaveCount(4);

  const paths = row.locator('[data-slot="attachment-title"]');
  await expect(paths).toHaveCount(4);
  expect(await paths.allTextContents()).toEqual([
    "/work/src/new.ts",
    "/work/src/edit.ts",
    "/work/src/old.ts",
    "/work/src/before.ts → /work/src/after.ts",
  ]);
  await expect(
    row
      .locator('[data-slot="attachment"]', {
        hasText: "/work/src/before.ts → /work/src/after.ts",
      })
      .getByRole("button"),
  ).toHaveCount(0);

  await row.getByLabel("Expand added file /work/src/new.ts").click();
  await row.getByLabel("Expand edited file /work/src/edit.ts").click();
  await row.getByLabel("Expand deleted file /work/src/old.ts").click();
  await expect(row.locator(".pierre-diff")).toHaveCount(3);
  await expect(
    row.getByText("This diff was truncated by the source.", { exact: false }),
  ).toBeVisible();

  await expect(row.getByLabel("Original record", { exact: true })).toContainText('"id": "patch"');

  await page.locator("#host-marker").click();
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.locator("main").evaluate((element) => {
    element.style.height = "1500px";
  });
  await row.screenshot({ path: "test-results/file-diff-attachments.png" });
  await page.setViewportSize({ width: 420, height: 1600 });
  await expect(paths.nth(3)).toBeVisible();
  await row.screenshot({ path: "test-results/file-diff-attachments-narrow.png" });
});
