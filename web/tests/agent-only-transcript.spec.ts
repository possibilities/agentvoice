import { expect, test } from "@playwright/test";
import { contextCompactionMessage } from "../src/transcript-ui/lib/system-events.ts";
import { parseCodexMessagePresentation } from "../src/transcript-ui/transcript/codex.ts";
import type { LiveView } from "../src/types.ts";

const controls = {
  available: true,
  active: false,
  pending: false,
  stopping: false,
  queue: [],
};

function fixture(): LiveView {
  const voiceContent =
    "<realtime_delegation><input>Review the release.</input><transcript_delta>user: Review the release.</transcript_delta></realtime_delegation>";
  return {
    id: "agent-only-fixture",
    persistenceScope: "agent-only-scope",
    phase: "live",
    agent: [
      {
        id: "voice-handoff",
        role: "user",
        status: "complete",
        content: voiceContent,
        presentation: parseCodexMessagePresentation(voiceContent),
      },
      {
        id: "typed-human",
        role: "user",
        status: "complete",
        content: "Typed follow-up",
      },
      {
        id: "command",
        role: "tool",
        status: "complete",
        content: "",
        toolActivity: { name: "Command", detail: "bun run test", state: "complete" },
      },
      { id: "compaction", ...contextCompactionMessage(true) },
      {
        id: "files",
        role: "tool",
        status: "complete",
        content: "",
        nativeItemType: "fileChange",
        toolActivity: { name: "Files", detail: "1 file", state: "complete" },
        fileChanges: [
          {
            path: "/work/src/app.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            diffTruncated: false,
          },
        ],
      },
      {
        id: "routing",
        role: "system",
        status: "complete",
        content: "Routing context updated.",
        nativeItemType: "agentusage.routing_context",
        routingContext: {
          generation: 1,
          revision: 1,
          mode: "full",
          current: { model: "gpt-5.6-sol", effort: "medium" },
        },
      },
    ],
    voice: [
      {
        id: "raw-voice",
        role: "user",
        status: "complete",
        content: "RAW VOICE LANE CONTENT MUST NOT RENDER",
      },
    ],
    agentControls: controls,
  };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`renders one headerless Agent transcript with every projected card on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      const key = "agentvoice:presentation:v1:browser";
      localStorage.setItem(key, "voice");
      const access = { reads: 0, writes: 0 };
      Object.assign(window, { panePreferenceAccess: access });
      const read = Storage.prototype.getItem;
      const write = Storage.prototype.setItem;
      Storage.prototype.getItem = function (candidate) {
        if (candidate === key) access.reads++;
        return read.call(this, candidate);
      };
      Storage.prototype.setItem = function (candidate, value) {
        if (candidate === key) access.writes++;
        return write.call(this, candidate, value);
      };
    });
    await page.route("**/api/live", (route) => route.fulfill({ json: fixture() }));
    await page.goto("/");

    await expect(page.locator(".app-header, .app-brand, .app-status")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "AgentVoice", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Transcript view" })).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              panePreferenceAccess: { reads: number; writes: number };
            }
          ).panePreferenceAccess,
      ),
    ).toEqual({ reads: 0, writes: 0 });
    await expect(page.getByRole("region", { name: "Voice", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Voice transcript", exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("RAW VOICE LANE CONTENT MUST NOT RENDER", { exact: true }),
    ).toHaveCount(0);

    const pane = page.locator(".transcript-pane");
    const agent = page.getByRole("region", { name: "Agent", exact: true });
    await expect(agent).toBeVisible();
    expect((await pane.boundingBox())?.y).toBe(0);
    expect((await agent.boundingBox())?.y).toBe(0);
    await expect(page.getByRole("textbox", { name: "Message Agent" })).toBeVisible();
    await expect(agent.getByRole("button", { name: "Command bun run test" })).toBeVisible();
    await expect(agent.getByRole("note", { name: "Context compacted" })).toBeVisible();
    await expect(agent.locator(".file-change-event")).toBeVisible();
    await expect(agent.getByRole("note", { name: "Routing context" })).toBeVisible();

    const voiceIcon = agent.getByRole("img", { name: "Via Voice", exact: true });
    await expect(voiceIcon).toHaveCount(1);
    await expect(voiceIcon.locator("..")).toHaveClass("message-author");
    await expect(voiceIcon.locator("..")).toContainText("Human");
    await expect(voiceIcon).not.toHaveAttribute("title");
    await expect(
      agent.getByText("Typed follow-up", { exact: true }).locator(".."),
    ).not.toContainText("Via Voice");
    const inspect = agent.getByRole("button", { name: "Inspect voice message" });
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await inspect.click();
    await expect(page.getByRole("dialog", { name: "Voice message details" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: `test-results/agent-only-${viewport.name}.png` });
  });
}

test("Agent history reveal does not wait for raw Voice history", async ({ page }) => {
  const view = fixture();
  view.agentHistoryLoading = true;
  view.voiceHistoryLoading = true;
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");

  await expect(page.locator(".transcript-pane > .transcript-status")).toHaveText(
    "Loading conversation…",
  );
  await expect(page.getByRole("region", { name: "Agent", exact: true })).toHaveCount(0);
  view.agentHistoryLoading = false;
  await expect(page.getByRole("region", { name: "Agent", exact: true })).toBeVisible();
  await expect(page.locator(".transcript-status")).toHaveCount(0);
  expect(view.voiceHistoryLoading).toBe(true);
  expect((await page.getByRole("region", { name: "Agent", exact: true }).boundingBox())?.y).toBe(0);
});
