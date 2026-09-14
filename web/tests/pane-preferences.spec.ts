import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const fixture = (): LiveView => ({
  id: "pane-fixture",
  persistenceScope: "pane-scope",
  phase: "live",
  agent: Array.from({ length: 100 }, (_, i) => ({
    id: `a${i}`,
    role: "assistant",
    status: "complete",
    content: `Agent ${i}. ${"Retained reading content. ".repeat(8)}`,
  })),
  voice: [{ id: "v", role: "user", status: "complete", content: "Voice fixture" }],
  agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
});

test("mode keeps mounted drafts and reading state through hidden updates, reconnect and reload", async ({
  page,
}) => {
  const view = fixture();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const modes = page.getByRole("group", { name: "Transcript view" });
  await expect(modes.getByRole("button", { name: "Both", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Keep this draft while Voice is selected");
  const scroll = page.getByRole("region", { name: "Agent transcript", exact: true });
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  const offset = await scroll.evaluate((el) => el.scrollTop);
  await modes.getByRole("button", { name: "Voice", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-lane="agent"] textarea')).toHaveCount(1);
  await expect(page.locator('[data-lane="agent"]')).toHaveCSS("opacity", "0");
  await expect(page.locator(".voice-dock")).toBeHidden();
  const voiceBottom = () =>
    page
      .getByRole("region", { name: "Voice transcript", exact: true })
      .evaluate((el) => el.getBoundingClientRect().bottom);
  await expect.poll(voiceBottom).toBe(await page.evaluate(() => innerHeight));
  view.agent.push({
    id: "new",
    role: "assistant",
    status: "complete",
    content: "Update while hidden",
  });
  view.phase = "unavailable";
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await expect(modes.getByRole("button", { name: "Voice", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  view.phase = "detached";
  await modes.getByRole("button", { name: "Both", exact: true }).click();
  await expect(input).toHaveValue("Keep this draft while Voice is selected");
  await expect(page.locator(".voice-dock")).toBeVisible();
  await expect(page.locator(".voice-dock")).toHaveCSS(
    "border-top-color",
    "rgba(197, 231, 145, 0.32)",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await page.locator(".voice-dock").boundingBox())!.y -
          (await page.locator(".agent-dock").boundingBox())!.y,
      ),
    )
    .toBeLessThan(1);
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - offset)).toBeLessThan(2);
  await expect(
    page.getByRole("button", { name: "1 new message. Jump to latest", exact: true }),
  ).toBeVisible();
  await modes.getByRole("button", { name: "Voice", exact: true }).click();
  await page.reload();
  await expect(modes.getByRole("button", { name: "Voice", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: "Voice", exact: true })).toBeVisible();
  await expect(page.locator(".voice-dock")).toBeHidden();
  await expect.poll(voiceBottom).toBe(await page.evaluate(() => innerHeight));
  await expect(
    page.getByRole("region", { name: "Voice", exact: true }).getByText("Voice fixture"),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/panes-voice.png" });
  await modes.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(input).toHaveValue("Keep this draft while Voice is selected");
  await expect(
    page.getByRole("region", { name: "Agent transcript", exact: true }).getByText(/Agent 99\./),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modes).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent transcript", exact: true }).getByText(/Agent 99\./),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "test-results/panes-agent-narrow.png" });
});

test("persistent kiosk identity restores selection in a new context without sessionStorage", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL });
  await first.addInitScript(() =>
    Object.defineProperty(window, "funkKiosk", {
      value: { persistenceInstanceId: "fixture.panes:main" },
    }),
  );
  const page = await first.newPage();
  await page.route("**/api/live", (route) => route.fulfill({ json: fixture() }));
  await page.goto("/");
  await page
    .getByRole("group", { name: "Transcript view" })
    .getByRole("button", { name: "Voice", exact: true })
    .click();
  const storageState = await first.storageState();
  await first.close();
  for (const identity of ["fixture.panes:main", "fixture.panes:other"]) {
    const next = await browser.newContext({ baseURL, storageState });
    await next.addInitScript(
      (identity) =>
        Object.defineProperty(window, "funkKiosk", { value: { persistenceInstanceId: identity } }),
      identity,
    );
    const reopened = await next.newPage();
    await reopened.route("**/api/live", (route) => route.fulfill({ json: fixture() }));
    await reopened.goto("/");
    await expect(
      reopened
        .getByRole("group", { name: "Transcript view" })
        .getByRole("button", { name: identity.endsWith("main") ? "Voice" : "Both", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await next.close();
  }
});

test("invalid preferences default to Both and unavailable storage keeps the switch usable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("agentvoice:presentation:v1:browser", "invalid"),
  );
  await page.route("**/api/live", (route) => route.fulfill({ json: fixture() }));
  await page.goto("/");
  const modes = page.getByRole("group", { name: "Transcript view" });
  await expect(modes.getByRole("button", { name: "Both", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "QuotaExceededError");
    };
  });
  await modes.getByRole("button", { name: "Voice", exact: true }).click();
  await expect(modes.getByRole("button", { name: "Voice", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("status").filter({ hasText: "this visit only" })).toBeVisible();
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
  });
  await page.reload();
  await expect(modes.getByRole("button", { name: "Both", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
