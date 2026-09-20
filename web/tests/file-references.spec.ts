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

test("the picker is absent and the full-width textarea explains keyboard and drop input", async ({
  page,
}) => {
  let fileApiRequests = 0;
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  await page.route("**/api/files", (route) => {
    fileApiRequests++;
    return route.fulfill({ status: 500 });
  });
  await page.goto("/");

  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await expect(page.getByRole("button", { name: "Reference a file" })).toHaveCount(0);
  await expect(page.locator(".transcript-file-picker")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const description = await input.getAttribute("aria-describedby");
  expect(description).toContain("instructions");
  await expect(page.locator(`#${description!.split(" ")[0]}`)).toContainText("Press Enter to send");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const inputBox = (await input.boundingBox())!;
    const groupBox = (await page.locator('[data-slot="input-group"]').boundingBox())!;
    expect(inputBox.width).toBe(groupBox.width);
    expect(inputBox.height).toBe(groupBox.height);
    expect(inputBox.height).toBeGreaterThanOrEqual(72);
    await input.focus();
    await expect(input).toBeFocused();
  }
  expect(fileApiRequests).toBe(0);
});

test("paste and drop insert absolute paths; filename-only drops explain missing paths", async ({
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
  expect(mutations).toBe(0);
  await page.reload();
  await expect(input).toHaveValue(
    "@/Users/operator/example.png @/Users/operator/design reference.png",
  );
});

test("drops reach a newer draft during a pending keyboard submission", async ({ page }) => {
  await page.route("**/api/live", (route) => route.fulfill({ json: makeView() }));
  let releaseSend!: () => void;
  const sending = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route("**/api/agent", async (route) => {
    await sending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("First request");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", "file:///Users/operator/next.png");
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(input).toHaveValue("@/Users/operator/next.png");
  releaseSend();
  await expect(input).toHaveValue("@/Users/operator/next.png");
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
