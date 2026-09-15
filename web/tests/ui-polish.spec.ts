import { expect, test } from "@playwright/test";
import { parseCodexMessagePresentation } from "../src/transcript-ui/transcript/codex.ts";
import type { LiveView } from "../src/types.ts";

for (const width of [1440, 390]) {
  test(`unified header and voice details remain readable, mono and keyboard accessible at ${width}px`, async ({
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
    const header = page.locator(".app-header");
    const modes = page.getByRole("group", { name: "Transcript view" });
    await expect(header.getByRole("heading", { name: "AgentVoice" })).toBeVisible();
    await expect(header.getByText(/Agent \+ Voice chat|Agent chat|Voice chat/)).toHaveCount(0);
    await expect(page.locator(".lane h1, .lane h2")).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "Message Agent" });
    await input.fill("Retained polish draft");
    const headerHeight = (await header.boundingBox())!.height;
    view.phase = "detached";
    const status = header.getByRole("status");
    await expect(status).toHaveText("");
    await expect(status).not.toHaveAttribute("data-visible");
    view.phase = "unavailable";
    await expect(status).toContainText("AgentVoice is unavailable. Reconnecting…");
    await expect(status).toHaveAttribute("data-visible", "true");
    await expect(status).toHaveCSS("text-align", "center");
    await expect(status).toHaveCSS("border-radius", "0px");
    const headerBox = (await header.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    expect(
      Math.abs(statusBox.x + statusBox.width / 2 - (headerBox.x + headerBox.width / 2)),
    ).toBeLessThan(1);
    expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(headerHeight);
    for (const label of ["Voice", "Agent", "Both"]) {
      const button = modes.getByRole("button", { name: label, exact: true });
      await button.focus();
      await page.keyboard.press("Space");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(header.getByText(`${label} chat`, { exact: true })).toHaveCount(0);
    }
    const headerBottom = (await header.boundingBox())!.y + (await header.boundingBox())!.height;
    for (const lane of ["Agent", "Voice"]) {
      expect(
        (await page.getByRole("region", { name: lane, exact: true }).boundingBox())!.y,
      ).toBeGreaterThanOrEqual(headerBottom);
    }
    const inspect = page.getByRole("button", { name: "Inspect voice message" });
    const inset = await inspect.evaluate((el) => {
      const icon = el.getBoundingClientRect();
      const card = el.closest(".voice-message")!.getBoundingClientRect();
      return { top: icon.top - card.top, right: card.right - icon.right };
    });
    expect(inset.top).toBeGreaterThanOrEqual(8);
    expect(inset.right).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: `test-results/polish-header-${width}.png` });
    await inspect.click();
    const dialog = page.getByRole("dialog", { name: "Voice message details" });
    await expect(dialog).toHaveCSS("border-radius", "0px");
    await expect(
      dialog.getByText("Compare the displayed handoff with its voice context and source."),
    ).toHaveCount(0);
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
