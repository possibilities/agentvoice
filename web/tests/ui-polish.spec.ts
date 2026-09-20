import { expect, test } from "@playwright/test";
import { parseCodexMessagePresentation } from "../src/transcript-ui/transcript/codex.ts";
import type { LiveView } from "../src/types.ts";

for (const width of [1440, 390]) {
  test(`headerless voice details remain readable, mono and keyboard accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const content =
      "<realtime_delegation><input>Review the fixture.</input><transcript_delta>user: Review the fixture.</transcript_delta></realtime_delegation>";
    const view: LiveView = {
      id: "polish",
      persistenceScope: "polish-scope",
      phase: "live",
      voice: [{ id: "v", role: "user", status: "complete", content: "Voice fixture" }],
      agent: [
        {
          id: "a",
          role: "user",
          status: "complete",
          content,
          presentation: parseCodexMessagePresentation(content),
        },
      ],
      agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
    };
    let unexpectedApiRequests = 0;
    await page.route("**/api/**", (route) => {
      if (new URL(route.request().url()).pathname === "/api/live")
        return route.fulfill({ json: view });
      unexpectedApiRequests += 1;
      return route.fulfill({ status: 403, json: { error: "Fixture blocks native actions" } });
    });
    await page.goto("/");
    await expect(page.locator("header.app-header, .app-brand, .app-status")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "AgentVoice" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Transcript view" })).toHaveCount(0);
    const lane = page.getByRole("region", { name: "Agent", exact: true });
    expect((await lane.boundingBox())!.y).toBe(0);
    const input = page.getByRole("textbox", { name: "Message Agent" });
    await input.fill("Retained polish draft");

    view.phase = "detached";
    await expect(page.locator(".transcript-status")).toHaveCount(0);
    view.phase = "unavailable";
    const status = page.locator(".transcript-status");
    await expect(status).toContainText("Agent transcript is reconnecting…");
    await expect(status).toHaveCSS("text-align", "center");
    await expect(status).toHaveCSS("border-radius", "0px");
    await expect(page.locator("header")).toHaveCount(0);

    await expect(page.getByText("Via Voice", { exact: true })).toHaveCount(0);
    const inspect = page.getByRole("button", { name: "Open voice message details" });
    await expect(inspect.locator("svg")).toBeVisible();
    await expect(inspect).not.toHaveAttribute("title");
    await page.screenshot({ path: `test-results/polish-headerless-${width}.png` });
    await inspect.click();
    const dialog = page.getByRole("dialog", { name: "Voice message details" });
    await expect(dialog).toHaveCSS("border-radius", "0px");
    const sans = await page.evaluate(() =>
      [...document.body.querySelectorAll<HTMLElement>("*")]
        .filter(
          (el) =>
            el.getClientRects().length &&
            getComputedStyle(el).visibility === "visible" &&
            !el.closest("[inert]") &&
            [...el.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            ) &&
            !/mono/i.test(getComputedStyle(el).fontFamily),
        )
        .map((el) => ({
          tag: el.tagName,
          font: getComputedStyle(el).fontFamily,
          text: el.textContent?.slice(0, 60),
        })),
    );
    expect(sans).toEqual([]);
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.screenshot({ path: `test-results/polish-modal-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();
    await expect(input).toHaveValue("Retained polish draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(unexpectedApiRequests).toBe(0);
  });
}
