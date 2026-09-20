import { expect, test } from "@playwright/test";
import { mapCodexSubagentActivity } from "../src/transcript-ui/transcript/codex.ts";
import type { TranscriptMessage } from "../src/transcript-ui/transcript/index.ts";
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

test("windowed collaboration tools keep every detail reachable after polling", async ({ page }) => {
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

  const tools = agent.locator(".tool-disclosure");
  await expect(tools).toHaveCount(3);

  for (const action of ["Started", "Completed"]) {
    const trigger = agent.locator(".tool-disclosure__trigger", { hasText: action });
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeInViewport();
    if (action === "Started") await trigger.click();
    else {
      await trigger.focus();
      await trigger.press("Enter");
    }
    const body = trigger.locator("..").getByLabel("Activity", { exact: true });
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
  await expect(tools).toHaveCount(4);
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
  await expect(agent.locator(".activity-group")).toHaveCount(0);
});

test("in-surface loading reveals Agent history without waiting for Voice history", async ({
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
  await expect(page.locator(".transcript-status")).toHaveText("Loading conversation…");
  await expect(page.getByRole("region", { name: "Agent transcript", exact: true })).toHaveCount(0);
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
  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(page.locator(".transcript-status")).toHaveCount(0);
  await expect(agent.getByText("Live Agent while history loads")).toBeInViewport();
  await expect
    .poll(() =>
      agent.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  expect(view.voiceHistoryLoading).toBe(true);
  view.agent.push(message("after-history", "New Agent after history"));
  await expect(agent.getByText("New Agent after history")).toBeInViewport();
});

test("the Agent transcript follows updates, retains disclosures, and ignores raw Voice rows", async ({
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
  await expect(page.getByRole("button")).toHaveCount(0);
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
      message("answer", "This raw Voice answer must stay hidden."),
    ],
    agent: [
      message("prompt", "Verify the live transcript reader.", "user"),
      ...Array.from({ length: 60 }, (_, i) =>
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
  const agent = page.getByRole("region", { name: "Agent transcript", exact: true });
  await expect(page.getByText("Could you check the connection?")).toHaveCount(0);
  await expect
    .poll(() =>
      agent.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  await expect(agent.locator("time")).toHaveCount(0);
  const lanes = page.locator(".lane");
  await expect(lanes).toHaveCount(1);
  await expect(lanes).toHaveAccessibleName("Agent");
  expect(await agent.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await agent.evaluate((el) => el.clientHeight)).toBeLessThan(1000);
  view.agent.push(message("draft", "Streaming draft"));
  await expect(agent.getByText("Streaming draft", { exact: true })).toBeInViewport();
  view.agent[view.agent.length - 1] = message("draft", "The canonical completion.");
  view.voice.push(message("voice-live", "I can see the update.", "user"));
  await expect(agent.getByText("The canonical completion.", { exact: true })).toBeInViewport();
  await expect(agent.getByText("Streaming draft", { exact: true })).toHaveCount(0);
  await expect(page.getByText("I can see the update.")).toHaveCount(0);
  expect(reads).toBeGreaterThan(3);
  await agent.locator(".tool-disclosure__trigger").click();
  await expect(agent.getByText("All checks passed", { exact: true })).toBeVisible();
  view.voice.push(message("still-watching", "Still watching."));
  await expect(page.getByText("Still watching.")).toHaveCount(0);
  await expect(agent.getByText("All checks passed", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/agent-transcript.png", fullPage: true });
  view = {
    phase: "live",
    id: "call-two",
    voice: [],
    agent: [message("new", "A new call is connected.")],
  };
  await expect(agent.getByText("A new call is connected.")).toBeVisible();
  await expect(agent.getByText("The canonical completion.")).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 600 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await expect(lanes).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("an empty retained session keeps the Agent transcript and an interactive composer", async ({
  page,
}) => {
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

  await expect(page.locator(".transcript-status")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent transcript", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No agent messages yet", exact: true }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await expect(input).toBeEnabled();
  await input.fill("Editable while voice is detached");
  await input.press("Enter");
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
              agent: [message("a", "Agent remains readable.")],
              agentNotice: "Agent transcript is catching up. Input remains available.",
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
  await expect(page.getByText("Voice remains readable.")).toHaveCount(0);
  await expect(
    page.getByText("Agent transcript is catching up. Input remains available.", { exact: true }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Retained through browser failure");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  fail = true;
  await expect(page.getByText("Agent transcript is reconnecting…")).toHaveCount(1);
  await expect(
    page.getByText(
      "Agent input is unavailable because the web reader disconnected. Your draft is still editable.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Agent transcript is catching up. Input remains available.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Agent transcript disconnected. Reconnecting…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Voice remains readable.")).toHaveCount(0);
  await expect(input).toHaveValue("Retained through browser failure");
  await input.press("Enter");
  await expect(input).toHaveValue("Retained through browser failure");
  fail = false;
  await expect(page.getByText("Agent transcript is reconnecting…")).toHaveCount(0);
  await expect(
    page.getByText(
      "Agent input is unavailable because the web reader disconnected. Your draft is still editable.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText("Agent transcript is catching up. Input remains available.", { exact: true }),
  ).toBeVisible();
});

test("the Agent transcript counts unread messages and resumes following after jumping", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const view: LiveView = {
    phase: "live",
    id: "follow-call",
    voice: [],
    agent: [],
  };
  view.agent = Array.from({ length: 25 }, (_, i) =>
    message(`agent-${i}`, `agent message ${i}. ${"Text to make the lane scroll. ".repeat(15)}`),
  );
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const section = page.getByRole("region", { name: "Agent", exact: true });
  const viewport = page.getByRole("region", { name: "Agent transcript", exact: true });
  const gap = () => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap).toBeLessThan(2);
  view.agent.push(message("agent-following", "Agent follows at bottom"));
  await expect(viewport.getByText("Agent follows at bottom")).toBeInViewport();
  await viewport.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  view.agent.push(message("agent-new-1", "Agent unread one"));
  await expect(
    section.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
  ).toBeVisible();
  view.agent[view.agent.length - 1] = message("agent-new-1", "Agent unread one completed");
  view.agent.push(message("agent-new-2", "Agent unread two"));
  const chip = section.getByRole("button", {
    name: "2 new messages. Jump to latest",
    exact: true,
  });
  await expect(chip).toBeVisible();
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(2);
  await chip.click();
  await expect.poll(gap).toBeLessThan(2);
  await expect(chip).toHaveCount(0);
  view.agent.push(message("agent-resumed", "Agent follows again"));
  await expect(viewport.getByText("Agent follows again")).toBeInViewport();
  await expect(section.getByRole("button", { name: /new messages?\. Jump to latest/ })).toHaveCount(
    0,
  );
  await page.screenshot({ path: "test-results/follow-chip.png", fullPage: true });
});
