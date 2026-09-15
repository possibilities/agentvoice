import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const initial = (): LiveView => ({
  id: "3235a2e5-f720-418b-bfaa-00856260ae91",
  persistenceScope: "workspace-thread-alpha",
  phase: "live",
  voice: [],
  agent: [
    {
      id: "answer",
      role: "assistant",
      content: "Existing history remains readable.",
      status: "complete",
    },
  ],
  agentControls: { available: true, active: false, stopping: false, pending: false, queue: [] },
});

test("detached sessions retain interactive drafts while unavailable sessions disable delivery", async ({
  page,
}) => {
  const view = initial();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Unsent draft before reconnect");
  view.phase = "detached";
  view.agentControls!.available = true;
  await expect(page.locator(".app-status")).toHaveText("");
  await expect(page.locator(".app-status")).not.toHaveAttribute("data-visible");
  await expect(page.getByText("Existing history remains readable.", { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await input.fill("Typed while detached 日本語");
  view.agent.push({
    id: "detached-native-work",
    role: "assistant",
    content: "Native work continued while voice was detached.",
    status: "complete",
  });
  await expect(page.getByText("Native work continued while voice was detached.")).toBeVisible();
  view.phase = "unavailable";
  view.agentControls!.available = false;
  await expect(page.getByText("AgentVoice is unavailable. Reconnecting…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(input).toHaveValue("Typed while detached 日本語");
  await page.reload();
  await expect(input).toHaveValue("Typed while detached 日本語");
  view.phase = "live";
  view.agentControls!.available = true;
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(input).toHaveValue("Typed while detached 日本語");
});

test("drafts are isolated by verified workspace/thread and retained when returning", async ({
  page,
}) => {
  const view = initial();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Thread alpha draft");
  view.id = "thread-beta-view";
  view.persistenceScope = "workspace-thread-beta";
  await expect(input).toHaveValue("");
  await input.fill("Thread beta draft");
  await page.reload();
  await expect(input).toHaveValue("Thread beta draft");
  view.id = "thread-alpha-return";
  view.persistenceScope = "workspace-thread-alpha";
  await expect(input).toHaveValue("Thread alpha draft");
});

test("reload preserves pending submitted text separately from the next draft and exact native echo reconciles it", async ({
  page,
}) => {
  const view = initial();
  let command: { requestId: string } | undefined;
  let posts = 0;
  let rejectSubmission: (() => void) | undefined;
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", async (route) => {
    posts++;
    command = route.request().postDataJSON();
    await new Promise<void>((resolve) => {
      rejectSubmission = resolve;
    });
    await route.fulfill({
      status: 409,
      json: { error: "Delivery uncertain", delivery: "unknown" },
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Submitted text to recover");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("Independent next draft");
  await expect.poll(() => Boolean(rejectSubmission)).toBe(true);
  rejectSubmission!();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("Independent next draft");
  await expect(page.getByRole("button", { name: "Restore sent text" })).toBeVisible();
  expect(posts).toBe(1);
  view.agent.push({
    id: `client:${command!.requestId}`,
    role: "user",
    content: "Authoritative corrected text",
    status: "complete",
  });
  await expect(page.getByRole("button", { name: "Restore sent text" })).toHaveCount(0);
  await expect(input).toHaveValue("Independent next draft");
  expect(posts).toBe(1);
});

test("user fence text remains visible in native history and optimistic messages", async ({
  page,
}) => {
  const view = initial();
  const sentence =
    "Reconcile the working-doctrine roadmap. Update the phases to reflect HUD and the guidance already shipped, then identify the next concrete phase.";
  const content = `For HUD it will take some time for me to validate it partly because I can’t restart things right. In the meantime can you do this?\n\n\`\`\`${sentence}\n\`\`\``;
  view.agent = [{ id: "fenced-user", role: "user", status: "complete", content }];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(transcript).toContainText(sentence);
  await expect(transcript.getByText(sentence, { exact: true })).toBeInViewport();
  await page.waitForTimeout(300); // Allow the shared message entrance transition to paint for the artifact.
  await page.screenshot({ path: "test-results/durable-malformed-fence.png", fullPage: true });
  const input = page.getByRole("textbox", { name: "Message Agent" });
  const conventional = "```text\nConventional fenced body remains readable.\n```";
  await input.fill(conventional);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(transcript).toContainText("Conventional fenced body remains readable.");
  await page.screenshot({ path: "test-results/durable-fenced-message.png", fullPage: true });
});
