import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

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
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await input.fill("Repeated text");
  await send.click();
  const users = page.locator('.chat-transcript [data-role="user"]');
  await expect(users).toHaveCount(1);
  await expect(users).toContainText("Repeated text");
  await expect(users).toContainText("Sending…");
  await expect(input).toHaveValue("");
  await input.fill("My next draft");
  await expect(send).toBeDisabled();
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
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue("My next draft");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await input.focus();
  await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(3, 7));
  await expect(input).toBeFocused();
  await page.screenshot({ path: "test-results/optimistic-reconciled.png", fullPage: true });
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
  const send = page.getByRole("button", { name: "Send", exact: true });
  await input.fill("Rejected request");
  await send.click();
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
  await send.click();
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

test("queue is immediate, authoritative edits win, and a call replacement fences pending state", async ({
  page,
}) => {
  const view = initial();
  view.agentControls!.active = true;
  let command: { requestId: string; text: string } | undefined;
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", async (route) => {
    command = route.request().postDataJSON();
    await response;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Follow-up behavior" }).click();
  await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Queued immediately");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Queued immediately");
  await expect(queue.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await expect(page.locator('.chat-transcript [data-role="user"]')).toHaveCount(0);
  view.agentControls!.queue = [
    {
      id: command!.requestId,
      text: "Corrected queue text",
      disabled: false,
      canSteer: true,
      canResume: false,
    },
  ];
  await expect(queue).toContainText("Corrected queue text");
  await expect(queue).not.toContainText("Queued immediately");
  await input.fill("Next call draft");
  view.id = "32ac32a9-5cf9-41fa-bd77-59ae4ac5a08b";
  view.persistenceScope = "replacement-workspace-thread";
  view.agentControls!.queue = [];
  await expect(input).toHaveValue("");
  await expect(queue).toHaveCount(0);
  release();
  await expect(queue).toHaveCount(0);
});
