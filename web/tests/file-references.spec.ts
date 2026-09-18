import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types";

const makeView = (): LiveView => ({
  phase: "live",
  id: "89e68874-f742-45c9-bd32-98123e74b164",
  persistenceScope: "file-reference-test",
  voice: [],
  agent: [],
  agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
});

test("picker inserts editable host paths; send, steer and queue remain text-only", async ({
  page,
}) => {
  const view = makeView();
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/files", (route) =>
    route.fulfill({
      json: {
        path: "/Users/operator",
        parent: null,
        truncated: false,
        entries: [
          {
            name: "design reference.png",
            path: "/Users/operator/design reference.png",
            kind: "file",
          },
          { name: "Documents", path: "/Users/operator/Documents", kind: "directory" },
        ],
      },
    }),
  );
  await page.route("**/api/agent", (route) => {
    commands.push(route.request().postDataJSON());
    view.agentControls!.active = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Inspect this please");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(8, 12));
  await page.getByRole("button", { name: "Reference a file", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "design reference.png Insert path" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/file-picker-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "design reference.png Insert path" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(input).toHaveValue("Inspect @/Users/operator/design reference.png please");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("Again @/Users/operator/design reference.png");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Follow-up behavior" }).click();
  await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click();
  await input.fill("Later @/Users/operator/design reference.png");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => commands.length).toBe(3);
  expect(commands.map((row) => row.action)).toEqual(["send", "steer", "queue"]);
  for (const row of commands) {
    expect(Object.keys(row).sort()).toEqual(["action", "requestId", "text", "viewId"]);
    expect(row.text).toContain("@/Users/operator/design reference.png");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Reference a file", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "design reference.png Insert path" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/file-picker-mobile.png", fullPage: true });
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(commands).toHaveLength(3);
});

test("paste and drop consume absolute paths; filename-only drops explain missing paths", async ({
  page,
}) => {
  let mutations = 0;
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  await page.route("**/api/agent", (route) => {
    mutations++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.focus();
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "/Users/operator/example.png");
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(input).toHaveValue("@/Users/operator/example.png");
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(element.value.length, element.value.length);
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", "file:///Users/operator/design%20reference.png");
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(input).toHaveValue(
    "@/Users/operator/example.png @/Users/operator/design reference.png",
  );
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["private bitmap bytes"], "image.png", { type: "image/png" }));
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByRole("alert")).toContainText("did not provide a full local file path");
  await expect(input).toHaveValue(
    "@/Users/operator/example.png @/Users/operator/design reference.png",
  );
  expect(await page.locator('input[type="file"]').count()).toBe(0);
  expect(mutations).toBe(0);
  await page.reload();
  await expect(input).toHaveValue(
    "@/Users/operator/example.png @/Users/operator/design reference.png",
  );
  await page.screenshot({ path: "test-results/file-reference-composer.png", fullPage: true });
});

test("pasting a copied worker task path preserves its canonical text", async ({
  context,
  page,
}) => {
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("/root/transcript_worker_path_copy"));
  await input.focus();
  await input.press("ControlOrMeta+V");
  await expect(input).toHaveValue("/root/transcript_worker_path_copy");
});

test("picker cancellation and folder errors preserve the draft", async ({ page }) => {
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  await page.route("**/api/files", (route) =>
    route.fulfill({ status: 403, json: { error: "This folder could not be opened." } }),
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Keep my draft");
  await page.getByRole("button", { name: "Reference a file", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("This folder could not be opened.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("Keep my draft");
  await expect(input).toBeFocused();
});

test("drops reach a newer draft during pending submission and picker responses preserve typed folder paths", async ({
  page,
}) => {
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  let releaseSend!: () => void;
  const sending = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route("**/api/agent", async (route) => {
    await sending;
    await route.fulfill({ json: { ok: true } });
  });
  let releaseListing!: () => void;
  const listing = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  await page.route("**/api/files", async (route) => {
    await listing;
    await route.fulfill({
      json: { path: "/Users/operator", parent: null, entries: [], truncated: false },
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("First request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", "file:///Users/operator/next.png");
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(input).toHaveValue("@/Users/operator/next.png");
  await page.getByRole("button", { name: "Reference a file", exact: true }).click();
  const folder = page.getByRole("textbox", { name: "Folder", exact: true });
  await folder.fill("/Users/operator/Documents");
  releaseListing();
  await expect(page.getByText("No matching files or folders.")).toBeVisible();
  await expect(folder).toHaveValue("/Users/operator/Documents");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect
    .poll(async () => (await page.getByRole("dialog").boundingBox())!.height)
    .toBeLessThanOrEqual(358);
  await page.screenshot({ path: "test-results/file-picker-landscape.png", fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  releaseSend();
  await expect(input).toHaveValue("@/Users/operator/next.png");
});
