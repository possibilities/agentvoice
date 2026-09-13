import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("Agent-only shared composer sends, steers, queues and edits without a Stop control through the host API", async ({
  page,
}) => {
  const view: LiveView = {
    phase: "live",
    id: "89e68874-f742-45c9-bd32-98123e74b164",
    voice: [],
    agent: [],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  const controls = view.agentControls!;
  const requests: Record<string, unknown>[] = [];
  let reject = true;
  const queuedId = "254aa7ef-a83e-4341-b2e3-da45f444990a";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    const command = route.request().postDataJSON();
    requests.push(command);
    if (reject)
      return route.fulfill({ status: 409, json: { error: "Codex rejected the request." } });
    if (command.action === "send") controls.active = true;
    if (command.action === "queue")
      controls.queue.push({
        id: queuedId,
        text: command.text,
        canSteer: true,
        canResume: false,
        disabled: false,
      });
    if (command.action === "edit") controls.queue[0]!.text = command.text;
    if (command.action === "remove") controls.queue = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const agent = page.getByRole("region", { name: "Agent", exact: true });
  const voice = page.getByRole("region", { name: "Voice", exact: true });
  const input = agent.getByRole("textbox", { name: "Message Agent" });
  await expect(voice.getByRole("textbox")).toHaveCount(0);
  await input.fill("Typed request");
  await agent.getByRole("button", { name: "Send", exact: true }).click();
  await expect(agent.getByRole("alert")).toHaveText("Codex rejected the request.");
  await expect(input).toHaveValue("Typed request");
  reject = false;
  await agent.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(agent.getByRole("button", { name: "Stop Agent" })).toHaveCount(0);
  await expect(agent.locator(".transcript-composer__progress")).toHaveText("Working…");
  await input.fill("Adjust direction");
  await agent.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(input).toHaveValue("");
  await agent.getByRole("button", { name: "Follow-up behavior" }).click();
  await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click();
  await input.fill("Work later");
  await agent.getByRole("button", { name: "Queue", exact: true }).click();
  const queue = agent.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("Work later", { exact: true })).toBeVisible();
  await queue.getByRole("button", { name: "Edit", exact: true }).click();
  const editInput = agent.getByRole("textbox", { name: "Edit queued message" });
  await expect(editInput).toHaveValue("Work later");
  await editInput.fill("Edited follow-up");
  await agent.getByRole("button", { name: "Save queued message" }).click();
  await expect(queue.getByText("Edited follow-up", { exact: true })).toBeVisible();
  controls.active = false;
  controls.stopping = false;
  await expect(input).not.toHaveAttribute("readonly");
  await page.screenshot({ path: "test-results/agent-composer.png", fullPage: true });
  await queue.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(queue).toHaveCount(0);
  expect(requests.map((row) => row.action)).toEqual([
    "send",
    "send",
    "steer",
    "queue",
    "editing",
    "edit",
    "editing",
    "remove",
  ]);
  expect(requests.every((row) => row.viewId === view.id && typeof row.requestId === "string")).toBe(
    true,
  );
  expect(new Set(requests.map((row) => row.requestId)).size).toBe(requests.length);
  expect(view.agent).toEqual([]);
  await input.fill("Draft for old call");
  view.id = "a4ce8004-c370-42a5-a833-b7ce64cece66";
  await expect(input).toHaveValue("");
  await page.setViewportSize({ width: 600, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
