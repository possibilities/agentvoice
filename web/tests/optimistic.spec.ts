import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

async function pasteImage(page: import("@playwright/test").Page) {
  await page.getByRole("textbox", { name: "Message Agent" }).evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(4)], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
}

const initial = (): LiveView => ({
  id: "3235a2e5-f720-418b-bfaa-00856260ae91",
  phase: "live",
  persistenceScope: "optimistic.spec.ts-workspace-thread",
  voice: [],
  agent: [],
  agentControls: { available: true, active: false, stopping: false, pending: false, queue: [] },
});

test("submitted text appears before acknowledgment, preserves next draft, and reconciles exact corrected identity", async ({
  page,
}) => {
  const view = initial();
  let command: { requestId: string; text: string } | undefined;
  let release!: () => void;
  const acknowledgment = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", async (route) => {
    command = route.request().postDataJSON();
    await acknowledgment;
    return route.abort("failed");
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await input.fill("Repeated text");
  await input.press("Enter");
  const users = page.locator('.chat-transcript [data-role="user"]');
  await expect(users).toHaveCount(1);
  await expect(users).toContainText("Repeated text");
  await expect(users).toContainText("Sending…");
  await expect(input).toHaveValue("");
  await input.fill("My next draft");
  await expect(input).toBeEditable();
  view.agent = [
    { id: "unrelated", role: "user", content: "Repeated text", status: "complete" },
    {
      id: `client:${command!.requestId}`,
      role: "user",
      content: "Authoritative corrected text",
      status: "complete",
    },
    { id: "reply", role: "assistant", content: "New response", status: "streaming" },
  ];
  await expect(users).toHaveCount(2);
  await expect(users.last()).toContainText("Authoritative corrected text");
  await expect(users.getByText("Sending…", { exact: true })).toHaveCount(0);
  release();
  await expect(input).toHaveValue("My next draft");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await input.focus();
  await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 7));
  await expect(input).toBeFocused();
  await page.screenshot({ path: "test-results/optimistic-reconciled.png", fullPage: true });
});

test("accepted code blocks stay exact while a partial native echo settles", async ({ page }) => {
  const view = initial();
  view.persistenceScope = "optimistic-code-block";
  let requestId = "";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    requestId = route.request().postDataJSON().requestId;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const code = "```text\n./bin/funk install-hardening\nPassword:\n```";
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill(code);
  await input.press("Enter");
  const users = page.locator('.chat-transcript [data-role="user"]');
  await expect(users).toHaveCount(1);
  await expect(users).toContainText("Accepted · waiting for transcript");
  await expect(users.locator("pre")).toHaveText("./bin/funk install-hardening\nPassword:\n");
  await expect.poll(() => requestId).not.toBe("");

  view.agent = [
    {
      id: `client:${requestId}`,
      role: "user",
      status: "streaming",
      content: `${code}\n\n./bin/funk install-hardening`,
    },
  ];
  await expect(users).toHaveCount(1);
  await expect
    .poll(() =>
      users.evaluate(
        (element) => element.textContent?.split("./bin/funk install-hardening").length ?? 0,
      ),
    )
    .toBe(2);
  await expect(users.locator("pre")).toHaveText("./bin/funk install-hardening\nPassword:\n");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/optimistic-code-block.png", fullPage: true });

  view.agent = [
    {
      id: `client:${requestId}`,
      role: "user",
      status: "complete",
      content: "Canonical corrected text",
    },
  ];
  await expect(users).toHaveCount(1);
  await expect(users).toContainText("Canonical corrected text");
  await expect(users).not.toContainText("Accepted · waiting for transcript");
  await expect(users.locator("pre")).toHaveCount(0);
});

test("accepted images render as attachments until exact canonical replacement", async ({
  page,
}) => {
  const view = initial();
  view.persistenceScope = "optimistic-image";
  let requestId = "";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/clipboard-image", (route) =>
    route.fulfill({ json: { path: "/workspace/.agentvoice-images/fixture.png" } }),
  );
  await page.route("**/api/agent", (route) => {
    requestId = route.request().postDataJSON().requestId;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await pasteImage(page);
  await expect(page.getByRole("list", { name: "Attached images" })).toBeVisible();
  await input.fill("Inspect the screenshot");
  await input.press("Enter");
  const user = page.locator('.chat-transcript [data-role="user"]');
  await expect(user).toHaveCount(1);
  await expect(user.getByText("1 image attached", { exact: true })).toBeVisible();
  await expect(user.getByText("Inspect the screenshot", { exact: true })).toBeVisible();
  await expect(user.getByText("[Image #1]", { exact: true })).toHaveCount(0);
  await expect.poll(() => requestId).not.toBe("");

  view.agent = [
    {
      id: `client:${requestId}`,
      role: "user",
      status: "streaming",
      content: "[Image #1]\n\nInspect",
    },
  ];
  await expect(user.getByText("1 image attached", { exact: true })).toBeVisible();
  await expect(user.getByText("[Image #1]", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/optimistic-image.png", fullPage: true });

  view.agent = [
    {
      id: `client:${requestId}`,
      role: "user",
      status: "complete",
      content: "[Image #1]\n\nCanonical image caption",
    },
  ];
  await expect(user.getByText("Canonical image caption", { exact: true })).toBeVisible();
  await expect(user.getByText("[Image #1]", { exact: true })).toBeVisible();
  await expect(user.getByText("1 image attached", { exact: true })).toHaveCount(0);
  await expect(user).not.toContainText("Accepted · waiting for transcript");
});

test("rejection keeps the new draft and recoverable sent text; unknown delivery stays visible until native echo", async ({
  page,
}) => {
  const view = initial();
  let command: { requestId: string; text: string } | undefined;
  let release!: () => void;
  let outcome: "reject" | "unknown" = "reject";
  let response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", async (route) => {
    command = route.request().postDataJSON();
    await response;
    return outcome === "reject"
      ? route.fulfill({ status: 409, json: { error: "Not accepted", delivery: "rejected" } })
      : route.abort("failed");
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Rejected request");
  await input.press("Enter");
  await input.fill("New draft");
  release();
  await expect(page.getByRole("alert")).toContainText("Not accepted");
  await expect(page.locator('.chat-transcript [data-role="user"]')).toHaveCount(0);
  await expect(input).toHaveValue("New draft");
  await expect(page.getByText("Rejected request", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore sent text" }).click();
  await expect(input).toHaveValue(/New draft[\s\S]*Rejected request/);
  outcome = "unknown";
  response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await input.fill("Unknown request");
  await input.press("Enter");
  release();
  const users = page.locator('.chat-transcript [data-role="user"]');
  await expect(users).toContainText("Delivery unknown");
  view.agent = [
    {
      id: `client:${command!.requestId}`,
      role: "user",
      content: "Unknown request",
      status: "complete",
    },
  ];
  await expect(users).toHaveCount(1);
  await expect(users).not.toContainText("Delivery unknown");
});
