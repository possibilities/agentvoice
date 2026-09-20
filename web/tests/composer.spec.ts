import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("keyboard submission sends while idle, steers while active, and never creates a queue", async ({
  page,
}) => {
  const view: LiveView = {
    phase: "live",
    persistenceScope: "composer.spec.ts-workspace-thread",
    id: "89e68874-f742-45c9-bd32-98123e74b164",
    voice: [],
    agent: [],
    agentControls: {
      available: true,
      active: false,
      pending: false,
      stopping: false,
      queue: [
        {
          id: "existing-queue",
          text: "Already queued by an older client",
          pausedReason: "Waiting for the current turn",
          canSteer: true,
          canResume: true,
          disabled: false,
        },
      ],
    },
  };
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    const command = route.request().postDataJSON();
    requests.push(command);
    if (command.action === "send") view.agentControls!.active = true;
    if (command.action === "remove") view.agentControls!.queue = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");

  const agent = page.getByRole("region", { name: "Agent", exact: true });
  const input = agent.getByRole("textbox", { name: "Message Agent" });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Follow-up behavior" })).toHaveCount(0);
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reference a file" })).toHaveCount(0);
  await expect(input).toHaveAttribute("aria-autocomplete", "none");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("spellcheck", "false");

  await input.fill("Typed request");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("Typed request\n");
  expect(requests).toHaveLength(0);
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.action).toBe("send");
  await expect(input).toHaveValue("");

  await expect(page.locator(".transcript-composer__activity-line")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.locator(".transcript-composer__status")).toHaveCount(0);
  await input.fill("Adjust direction");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.action).toBe("steer");
  expect(requests.some((request) => request.action === "queue")).toBe(false);

  const queue = agent.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("Already queued by an older client", { exact: true })).toBeVisible();
  await expect(queue.getByText("Waiting for the current turn", { exact: true })).toBeVisible();
  await expect(queue.getByRole("button")).toHaveCount(1);
  await expect(queue.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await queue.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]?.action).toBe("remove");
  await expect(queue).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
