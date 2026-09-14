import type { TranscriptMessage } from "@agentchats/transcript";
import { mapCodexSubagentActivity } from "@agentchats/transcript/codex";
import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const message = (
  id: string,
  content: string,
  role: TranscriptMessage["role"] = "assistant",
): TranscriptMessage => ({ id, role, content, status: "complete" });

const subagentMessage = (id: string, kind: string, agentPath: string): TranscriptMessage => {
  const mapped = mapCodexSubagentActivity({
    id,
    kind,
    agentThreadId: `thread-${id}`,
    agentPath,
  })!;
  return {
    id,
    role: "tool",
    content: mapped.content,
    status: "complete",
    toolActivity: mapped.activity,
  };
};

test("windowed subagent groups keep every lifecycle body reachable after polling", async ({
  page,
}) => {
  const singleton = subagentMessage(
    "interaction",
    "interacted",
    "/root/android_disconnected_layout",
  );
  const separator = message("separator", "The child work is continuing.");
  const started = subagentMessage("spawn", "started", "/root/layout_worker");
  const completed = subagentMessage("completion", "completed", "/root/layout_worker");
  let view: LiveView = {
    phase: "live",
    id: "subagent-details",
    persistenceScope: "subagent-details-thread",
    voice: [],
    agent: [singleton, separator, started, completed],
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");

  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  const singletonTrigger = agent.locator(".tool-disclosure__trigger", {
    hasText: "/root/android_disconnected_layout",
  });
  await singletonTrigger.click();
  await expect(agent.getByLabel("Agent thread", { exact: true })).toHaveText("thread-interaction");

  const group = agent.locator(".activity-group__trigger");
  await expect(group).toContainText("2 subagent activities");
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const children = agent.locator(".activity-group__items .tool-disclosure");
  await expect(children).toHaveCount(2);

  for (const [index, action] of ["Started", "Completed"].entries()) {
    const trigger = children.nth(index).locator(".tool-disclosure__trigger");
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeInViewport();
    if (index === 0) await trigger.click();
    else {
      await trigger.focus();
      await trigger.press("Enter");
    }
    const body = children.nth(index).getByLabel("Activity", { exact: true });
    await body.scrollIntoViewIfNeeded();
    await expect(body).toHaveText(action);
    await expect(body).toBeInViewport();
  }

  view = {
    ...view,
    agent: [
      { ...singleton },
      separator,
      { ...started },
      { ...completed },
      subagentMessage("followup", "interacted", "/root/reviewer"),
    ],
  };
  await expect(children).toHaveCount(3);
  await expect(group).toHaveAttribute("aria-expanded", "true");
  for (const action of ["Started", "Completed"])
    await expect(agent.locator(".tool-disclosure__trigger", { hasText: action })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  const followup = agent.locator(".tool-disclosure__trigger", {
    hasText: "/root/reviewer",
  });
  await followup.scrollIntoViewIfNeeded();
  await expect(followup).toBeInViewport();
});

test("one centered loading state reveals both histories at the end and preserves later Voice scrolling", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let view: LiveView = {
    phase: "live",
    id: "loading-call",
    persistenceScope: "loading-workspace-thread",
    agentHistoryLoading: true,
    voiceHistoryLoading: true,
    agentNotice: "Loading earlier messages…",
    agent: [message("live", "Live Agent while history loads")],
    voice: Array.from({ length: 25 }, (_, i) =>
      message(`voice-${i}`, `Speech ${i}. ${"Words. ".repeat(80)}`),
    ),
    agentControls: {
      available: true,
      active: false,
      stopping: false,
      pending: false,
      queue: [],
    },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("Loading conversation…");
  await expect(page.getByRole("region", { name: "Voice transcript", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent transcript", exact: true })).toHaveCount(0);
  const status = await page.getByRole("status").boundingBox();
  expect(Math.abs(status!.x + status!.width / 2 - 720)).toBeLessThan(1);
  expect(Math.abs(status!.y + status!.height / 2 - 500)).toBeLessThan(1);
  view = {
    ...view,
    agentHistoryLoading: false,
    agentNotice: undefined,
    agent: [
      ...Array.from({ length: 50 }, (_, i) =>
        message(`history-${i}`, `History ${i}. ${"Earlier words. ".repeat(80)}`),
      ),
      ...view.agent,
    ],
  };
  await expect.poll(() => page.locator(".dual-pane").getAttribute("hidden")).toBe("");
  view.voiceHistoryLoading = false;
  const voice = page.getByRole("region", { name: "Voice transcript", exact: true });
  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(page.locator(".view-status")).toHaveCount(0);
  await expect(agent.getByText("Live Agent while history loads")).toBeInViewport();
  for (const lane of [voice, agent])
    await expect
      .poll(() =>
        lane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
      )
      .toBeLessThan(2);
  await voice.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => voice.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  view.agent.push(message("after-history", "New Agent after history"));
  await expect(agent.getByText("New Agent after history")).toBeInViewport();
  expect(await voice.evaluate((element) => element.scrollTop)).toBeLessThan(2);
});

test("two independent transcripts follow live updates, retain disclosures, and reconnect without call controls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let reads = 0;
  let view: LiveView = { phase: "offline", id: "offline", voice: [], agent: [] };
  await page.route("**/api/live", async (route) => {
    reads++;
    await route.fulfill({ json: view });
  });
  await page.goto("/");
  await expect(page.getByText("No agent voice server to connect to.")).toHaveCount(1);
  await expect(page.getByRole("button")).toHaveCount(3);
  await expect(
    page.getByRole("group", { name: "Transcript view" }).getByRole("button"),
  ).toHaveCount(3);
  view = { ...view, phase: "empty", id: "empty" };
  await expect(
    page.getByText("AgentVoice is ready. Start a client to begin a workspace session."),
  ).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message Agent" })).toHaveCount(0);
  view = {
    phase: "live",
    id: "call-one",
    voice: [
      message("human", "Could you check the connection?", "user"),
      message("answer", "The two transcripts are connected."),
    ],
    agent: [
      message("prompt", "Verify the live transcript reader.", "user"),
      ...Array.from({ length: 24 }, (_, i) =>
        message(`old-${i}`, `Check ${i + 1}. ${"The observation is read-only. ".repeat(8)}`),
      ),
      message("tool", "", "tool"),
    ],
  };
  view.agent.at(-1)!.toolActivity = {
    name: "Command",
    detail: "bun run test",
    state: "complete",
    sections: [{ label: "Output", content: "All checks passed" }],
  };
  const voice = page.getByRole("region", { name: "Voice transcript", exact: true });
  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(voice.getByText("Could you check the connection?")).toBeVisible();
  await expect
    .poll(() =>
      agent.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  await expect(voice.locator(".message-author").first()).toHaveText("Human");
  await expect(voice.locator(".message-author").last()).toHaveText("Agent");
  await expect(agent.locator("time")).toHaveCount(0);
  const lanes = page.locator(".lane");
  await expect(lanes.nth(0).getByRole("heading", { level: 1 })).toHaveText("Agent");
  await expect(lanes.nth(1).getByRole("heading", { level: 1 })).toHaveText("Voice");
  const left = await lanes.nth(0).boundingBox();
  const right = await lanes.nth(1).boundingBox();
  expect(left!.y).toBe(right!.y);
  expect(left!.width).toBe(right!.width);
  expect(right!.x).toBeGreaterThan(left!.x);
  expect(await agent.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await agent.evaluate((el) => el.clientHeight)).toBeLessThan(1000);
  view.agent.push(message("draft", "Streaming draft"));
  await expect(agent.getByText("Streaming draft", { exact: true })).toBeInViewport();
  view.agent[view.agent.length - 1] = message("draft", "The canonical completion.");
  view.voice.push(message("voice-live", "I can see the update.", "user"));
  await expect(agent.getByText("The canonical completion.", { exact: true })).toBeInViewport();
  await expect(agent.getByText("Streaming draft", { exact: true })).toHaveCount(0);
  await expect(voice.getByText("I can see the update.")).toBeInViewport();
  expect(reads).toBeGreaterThan(3);
  await agent.locator(".tool-disclosure__trigger").click();
  await expect(agent.getByText("All checks passed", { exact: true })).toBeVisible();
  view.voice.push(message("still-watching", "Still watching."));
  await expect(voice.getByText("Still watching.")).toBeVisible();
  await expect(agent.getByText("All checks passed", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/dual-pane.png", fullPage: true });
  view = {
    phase: "live",
    id: "call-two",
    voice: [],
    agent: [message("new", "A new call is connected.")],
  };
  await expect(agent.getByText("A new call is connected.")).toBeVisible();
  await expect(agent.getByText("The canonical completion.")).toHaveCount(0);
  await expect(voice.getByText("No recorded speech.")).toBeVisible();
  await page.setViewportSize({ width: 600, height: 600 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  const narrowLeft = await lanes.nth(0).boundingBox();
  const narrowRight = await lanes.nth(1).boundingBox();
  expect(narrowLeft!.y).toBe(narrowRight!.y);
  expect(errors).toEqual([]);
});

test("an empty retained session keeps both lanes and an interactive composer", async ({ page }) => {
  let posts = 0;
  const view: LiveView = {
    phase: "detached",
    id: "detached-incarnation",
    persistenceScope: "retained-workspace-thread",
    voice: [],
    agent: [],
    agentControls: {
      available: true,
      active: false,
      stopping: false,
      pending: false,
      queue: [],
    },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    posts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");

  await expect(
    page.getByText("Voice client detached. Agent remains available.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent transcript", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Voice transcript", exact: true })).toBeVisible();
  await expect(page.getByText("No agent messages yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No recorded speech.", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await expect(input).toBeEnabled();
  await input.fill("Editable while voice is detached");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
});

test("HTTP failures show reconnect state, retain last text, and recover automatically", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/api/live", (route) =>
    route.fulfill(
      fail
        ? { status: 503, body: "Unavailable" }
        : {
            json: {
              phase: "live",
              id: "call",
              persistenceScope: "http-failure-workspace-thread",
              voice: [message("v", "Voice remains readable.")],
              agent: [],
              agentControls: {
                available: true,
                active: false,
                stopping: false,
                pending: false,
                queue: [],
              },
            },
          },
    ),
  );
  await page.goto("/");
  await expect(page.getByText("Voice remains readable.")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Retained through browser failure");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  fail = true;
  await expect(page.getByText("AgentVoice is unavailable. Reconnecting…")).toHaveCount(1);
  await expect(page.getByText("Voice remains readable.")).toBeVisible();
  await expect(input).toHaveValue("Retained through browser failure");
  await expect(send).toBeDisabled();
  fail = false;
  await expect(page.getByText("AgentVoice is unavailable. Reconnecting…")).toHaveCount(0);
  await expect(send).toBeEnabled();
});

test("both lanes use the shared unread count and resume following after jumping", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const view: LiveView = {
    phase: "live",
    id: "follow-call",
    voice: [],
    agent: [],
  };
  for (const lane of ["voice", "agent"] as const) {
    view[lane] = Array.from({ length: 25 }, (_, i) =>
      message(
        `${lane}-${i}`,
        `${lane} message ${i}. ${"Text to make the lane scroll. ".repeat(15)}`,
      ),
    );
  }
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  for (const lane of ["voice", "agent"] as const) {
    const title = lane === "voice" ? "Voice" : "Agent";
    const section = page.getByRole("region", { name: title, exact: true });
    const viewport = page.getByRole("region", { name: `${title} transcript`, exact: true });
    const gap = () => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(gap).toBeLessThan(2);
    view[lane].push(message(`${lane}-following`, `${title} follows at bottom`));
    await expect(viewport.getByText(`${title} follows at bottom`)).toBeInViewport();
    await viewport.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
    view[lane].push(message(`${lane}-new-1`, `${title} unread one`));
    await expect(
      section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
    ).toBeVisible();
    view[lane][view[lane].length - 1] = message(`${lane}-new-1`, `${title} unread one completed`);
    view[lane].push(message(`${lane}-new-2`, `${title} unread two`));
    const chip = section.getByRole("button", {
      name: "2 new messages. Jump to latest",
      exact: true,
    });
    await expect(chip).toBeVisible();
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
    await chip.click();
    await expect.poll(gap).toBeLessThan(2);
    await expect(chip).toHaveCount(0);
    view[lane].push(message(`${lane}-resumed`, `${title} follows again`));
    await expect(viewport.getByText(`${title} follows again`)).toBeInViewport();
    await expect(
      section.getByRole("button", { name: /new messages?\. Jump to latest/ }),
    ).toHaveCount(0);
  }
  await page.screenshot({ path: "test-results/follow-chip.png", fullPage: true });
});
