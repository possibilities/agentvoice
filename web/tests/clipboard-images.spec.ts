import { expect, type Page, test } from "@playwright/test";
import type { LiveView } from "../src/types";

const imagePath = (id: number) => `/workspace/.agentvoice-images/thread/clipboard-${id}.png`;
const view = (): LiveView => ({
  phase: "live",
  id: "89e68874-f742-45c9-bd32-98123e74b164",
  persistenceScope: "clipboard-images-test",
  voice: [],
  agent: [],
  agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
});
async function pasteImage(page: Page, count = 1, size = 4, type = "image/png") {
  await page
    .getByRole("textbox", { name: /Message Agent|Edit queued message/, exact: true })
    .evaluate(
      (element, { count, size, type }) => {
        const transfer = new DataTransfer();
        for (let i = 0; i < count; i++)
          transfer.items.add(new File([new Uint8Array(size)], `clipboard-${i}.png`, { type }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      },
      { count, size, type },
    );
}

test("raw paste materializes local files, persists atomic image paths and sends no bytes in control payload", async ({
  page,
}) => {
  const state = view();
  const commands: Record<string, unknown>[] = [];
  let saved = 0;
  await page.route("**/api/live", (route) => route.fulfill({ json: state }));
  await page.route("**/api/clipboard-image", (route) => {
    expect(route.request().headers()["content-type"]).toBe("image/png");
    expect(route.request().headers()["x-agentvoice-view-id"]).toBe(state.id);
    expect(route.request().headers()["x-agentvoice-image-id"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(route.request().postDataBuffer()).toHaveLength(4);
    return route.fulfill({ json: { path: imagePath(++saved) } });
  });
  await page.route("**/api/agent", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await pasteImage(page, 2);
  const attachments = page.getByRole("list", { name: "Attached images" });
  await expect(attachments.getByText("[Image #2]", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(attachments.getByText("[Image #2]", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/clipboard-images-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.screenshot({ path: "test-results/clipboard-images-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/clipboard-images-landscape.png", fullPage: true });
  await attachments.getByRole("button", { name: "Remove Image #1" }).click();
  await expect(attachments.getByText("[Image #2]", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ action: "send", text: "", images: [{ path: imagePath(2) }] });
  expect(Object.keys(commands[0]!).sort()).toEqual([
    "action",
    "images",
    "requestId",
    "text",
    "viewId",
  ]);
  expect(JSON.stringify(commands[0])).not.toContain("base64");
  await expect(attachments).toHaveCount(0);
});

test("image failures retain draft, newer image drafts survive rejected submissions and queue editing preserves images", async ({
  page,
}) => {
  const state = view();
  state.agentControls!.active = true;
  let saved = 0;
  let reject = true;
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: state }));
  await page.route("**/api/clipboard-image", (route) =>
    route.fulfill({ json: { path: imagePath(++saved) } }),
  );
  await page.route("**/api/agent", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (reject) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill({ status: 409, json: { error: "Codex rejected this message." } });
    }
    if (command.action === "queue")
      state.agentControls!.queue.push({
        id: command.requestId,
        text: command.text,
        images: command.images,
        canSteer: true,
        canResume: false,
        disabled: false,
      });
    if (command.action === "edit")
      Object.assign(state.agentControls!.queue[0]!, { text: command.text, images: command.images });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("First image");
  await pasteImage(page);
  await expect(page.getByRole("list", { name: "Attached images" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await input.fill("Newer draft");
  await pasteImage(page);
  await expect(page.getByRole("button", { name: "Restore sent message" })).toBeVisible();
  await expect(input).toHaveValue("Newer draft");
  await page.getByRole("button", { name: "Restore sent message" }).click();
  await expect(
    page.getByRole("list", { name: "Attached images" }).getByText("[Image #2]", { exact: true }),
  ).toBeVisible();
  reject = false;
  await page.getByRole("button", { name: "Follow-up behavior" }).click();
  await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("[Image #2]", { exact: true })).toBeVisible();
  await input.fill("Saved draft");
  await pasteImage(page);
  await expect(page.getByRole("list", { name: "Attached images" })).toBeVisible();
  await queue.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("list", { name: "Attached images" })
    .getByRole("button", { name: "Remove Image #1" })
    .click();
  await page.getByRole("textbox", { name: "Edit queued message" }).fill("Edited queue");
  await page.getByRole("button", { name: "Save queued message" }).click();
  await expect(input).toHaveValue("Saved draft");
  await expect(page.getByRole("list", { name: "Attached images" }).locator("li")).toHaveAttribute(
    "title",
    imagePath(3),
  );
  expect(commands.find((command) => command.action === "edit")?.images).toEqual([
    { path: imagePath(1) },
  ]);
});

test("save errors, type/size limits and cancellation do not submit a message or lose text", async ({
  page,
}) => {
  await page.route("**/api/live", (route) => route.fulfill({ json: view() }));
  let saves = 0;
  let pending = false;
  await page.route("**/api/clipboard-image", async (route) => {
    saves++;
    if (pending) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return route.fulfill({ json: { path: imagePath(1) } }).catch(() => {});
    }
    return route.fulfill({ status: 400, json: { error: "Clipboard image is invalid." } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Keep text");
  await pasteImage(page, 1, 10 * 1024 * 1024 + 1);
  await expect(page.getByRole("alert")).toContainText("10 MiB");
  expect(saves).toBe(0);
  await pasteImage(page, 1, 4, "image/svg+xml");
  await expect(page.getByRole("alert")).toContainText("PNG, JPEG");
  expect(saves).toBe(0);
  await pasteImage(page);
  await expect(page.getByRole("alert")).toContainText("Clipboard image is invalid");
  pending = true;
  await pasteImage(page);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel paste" }).click();
  await expect(page.getByRole("alert")).toContainText("cancelled");
  await expect(input).toHaveValue("Keep text");
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0);
});

test("image-only uncertain delivery survives reload and reconciles by native client identity", async ({
  page,
}) => {
  const state = view();
  let requestId = "";
  let submissions = 0;
  await page.route("**/api/live", (route) => route.fulfill({ json: state }));
  await page.route("**/api/clipboard-image", (route) =>
    route.fulfill({ json: { path: imagePath(1) } }),
  );
  await page.route("**/api/agent", async (route) => {
    submissions++;
    requestId = route.request().postDataJSON().requestId;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return route.fulfill({
      status: 502,
      json: { error: "Delivery uncertain", delivery: "unknown" },
    });
  });
  await page.goto("/");
  await pasteImage(page);
  await expect(page.getByRole("list", { name: "Attached images" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message Agent", exact: true })
    .fill("Independent next draft");
  await expect(page.getByRole("button", { name: "Restore sent message" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Restore sent message" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Message images" })).toContainText("[Image #1]");
  expect(submissions).toBe(1);
  state.agent.push({
    id: `client:${requestId}`,
    role: "user",
    content: "[Image #1]",
    status: "complete",
  });
  await expect(page.getByRole("button", { name: "Restore sent message" })).toHaveCount(0);
  expect(submissions).toBe(1);
});
