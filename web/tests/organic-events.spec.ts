import { expect, test } from "@playwright/test";
import { mapCodexSubagentEvent } from "../src/transcript-ui/lib/api/codex-subagent-event.ts";
import { contextCompactionMessage } from "../src/transcript-ui/lib/system-events.ts";
import { parseCodexMessagePresentation } from "../src/transcript-ui/transcript/codex.ts";
import type { LiveView } from "../src/types.ts";

function routing(id: string, revision: number) {
  return {
    id,
    role: "system" as const,
    status: "complete" as const,
    content: "Routing context updated.",
    nativeItemType: "agentusage.routing_context",
    routingContext: {
      generation: 7,
      revision,
      mode: revision === 1 ? ("full" as const) : ("delta" as const),
      current: revision === 1 ? { model: "gpt-5.6-sol", effort: "medium" } : undefined,
      balances: [
        {
          provider: "Codex" as const,
          account: "codex-1",
          lane: "primary",
          usedPercent: 20 + revision,
        },
      ],
    },
  };
}

test("machine events share one generic Tool call shell with specialized inner details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const voiceContent =
    "<realtime_delegation><input>Inspect the event flow.</input><transcript_delta>user: Inspect the event flow.</transcript_delta></realtime_delegation>";
  const lifecycle = mapCodexSubagentEvent({
    id: "lifecycle-native",
    kind: "completed",
    agentPath: "/root/obsolete-lifecycle",
    agentThreadId: "child-thread",
  })!;
  const compaction = { id: "compact", ...contextCompactionMessage(false) };
  const fileMessage: LiveView["agent"][number] = {
    id: "files",
    role: "tool" as const,
    status: "working" as const,
    nativeItemType: "fileChange",
    content: "",
    toolActivity: {
      name: "Files",
      detail: "1 file",
      meta: "inProgress",
      state: "running" as const,
      sections: [
        {
          label: "Original record",
          content: JSON.stringify({ type: "fileChange", id: "files", status: "inProgress" }),
        },
      ],
    },
    fileChanges: [
      {
        path: "/work/src/app.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        diffTruncated: false,
      },
    ],
  };
  const view: LiveView = {
    id: "organic-events",
    persistenceScope: "organic-events",
    phase: "live",
    voice: [],
    agent: [
      { id: "before", role: "assistant", status: "complete", content: "Before events" },
      {
        id: "voice-human",
        role: "user",
        status: "complete",
        content: voiceContent,
        presentation: parseCodexMessagePresentation(voiceContent),
      },
      {
        id: "tool",
        role: "tool",
        status: "complete",
        content: "",
        toolActivity: {
          name: "Command",
          detail: "bun run test",
          state: "complete",
          sections: [{ label: "Output", content: "741 tests passed" }],
        },
      },
      compaction,
      routing("routing-1", 1),
      routing("routing-2", 2),
      fileMessage,
      { id: "lifecycle", ...lifecycle },
      {
        id: "future-system",
        role: "system",
        status: "complete",
        content: "Index refresh finished.",
        nativeItemType: "futureSystemEvent",
        presentation: {
          title: "Index refreshed",
          body: "Search data is current.",
          details: [{ label: "Original event", content: '{"revision":42}' }],
        },
      },
      { id: "after", role: "assistant", status: "complete", content: "After events" },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });

  await expect(page.getByText("Via Voice", { exact: true })).toHaveCount(0);
  await expect(
    transcript.getByRole("button", { name: "Open voice message details" }),
  ).toBeVisible();
  const tool = transcript.locator(".tool-disclosure", { hasText: "bun run test" });
  await tool.getByRole("button").focus();
  await tool.getByRole("button").press("Enter");
  await expect(tool.getByLabel("Output", { exact: true })).toHaveText("741 tests passed");

  const compacting = transcript.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Context compaction",
  });
  await expect(compacting).toHaveAttribute("data-state", "running");
  await compacting.evaluate((element) => element.setAttribute("data-retained", "yes"));
  Object.assign(compaction, contextCompactionMessage(true));
  await expect(compacting).toHaveAttribute("data-retained", "yes");
  await expect(compacting).toHaveAttribute("data-state", "complete");

  const activityGroup = transcript.locator(".activity-group__trigger");
  await expect(activityGroup).toContainText("2 activities");
  await activityGroup.focus();
  await activityGroup.press("Enter");
  const routingActivity = transcript.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Routing context",
  });
  await routingActivity.getByRole("button").click();
  await expect(routingActivity.getByLabel("Routing update 2", { exact: true })).toContainText(
    '"usedPercent": 22',
  );

  const fileRow = transcript.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "File change",
  });
  await expect(fileRow).toHaveAttribute("data-state", "running");
  await fileRow.getByRole("button").first().click();
  await expect(fileRow.getByText("/work/src/app.ts", { exact: true })).toBeVisible();
  await fileRow.getByLabel("Expand edited file /work/src/app.ts").focus();
  await fileRow.getByLabel("Expand edited file /work/src/app.ts").press("Enter");
  await expect(fileRow.locator(".pierre-diff")).toBeVisible();
  await expect(fileRow.getByLabel("Original record", { exact: true })).toContainText(
    '"status":"inProgress"',
  );
  fileMessage.status = "complete";
  fileMessage.toolActivity!.state = "complete";
  fileMessage.toolActivity!.meta = "completed";
  await expect(fileRow).toHaveAttribute("data-state", "complete");

  const system = transcript.locator('.tool-disclosure[data-transcript-type="tool-call"]', {
    hasText: "Index refreshed",
  });
  await system.getByRole("button").focus();
  await system.getByRole("button").press("Enter");
  await expect(system.getByLabel("Original event", { exact: true })).toHaveText('{"revision":42}');

  await expect(transcript.getByText("/root/obsolete-lifecycle", { exact: true })).toHaveCount(0);
  await expect(
    transcript.locator(
      ".system-event-card, .routing-context-card, .file-change-event, .file-disclosure",
    ),
  ).toHaveCount(0);
  await expect(transcript.locator(".activity-group")).toHaveCount(1);
  await expect(
    transcript.locator('.tool-disclosure[data-transcript-type="tool-call"]'),
  ).toHaveCount(5);
  expect(
    await transcript
      .locator("[data-windowed-row-key]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-windowed-row-key"))),
  ).toEqual([
    "block:before",
    "block:voice-human",
    "block:tool",
    "block:compact",
    "block:routing-1",
    "block:future-system",
    "block:after",
  ]);

  await routingActivity.getByRole("button").click();
  await fileRow.getByLabel("Collapse edited file /work/src/app.ts").click();
  await fileRow.getByRole("button").first().click();
  await system.getByRole("button").click();
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/organic-events-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/organic-events-mobile.png" });
});
