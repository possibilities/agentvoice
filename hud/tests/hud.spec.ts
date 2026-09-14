import { expect, type Page, test } from "@playwright/test";
import { completeSnapshot, partialSnapshot, unavailableSnapshot } from "./fixtures.ts";

async function serveSnapshot(page: Page, snapshot = completeSnapshot(), refreshTimestamp = true) {
  await page.route("**/api/hud", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...snapshot,
        observedAt: refreshTimestamp ? new Date().toISOString() : snapshot.observedAt,
      }),
    });
  });
}

test("renders durable outcomes and every hierarchy depth", async ({ page }) => {
  await serveSnapshot(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Awaiting acceptance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Awaiting presentation" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Awaiting presentation" })
      .getByText("Accepted", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Return a fourth-depth nested result")).toBeVisible();
  await expect(page.getByText("Depth 4", { exact: true })).toBeVisible();
  await expect(page.getByText("Dense-state review")).toBeVisible();
  await expect(page.getByText("Unassigned observed threads")).toBeVisible();
  await expect(page.locator(".thread-tree").getByText("Recovered orphan")).toBeVisible();
  await expect(page.getByText("Parent not loaded", { exact: true })).toBeVisible();
  await expect(page.getByText("Not dispatched", { exact: true })).toBeVisible();
  await expect(page.getByText("no state inferred from silence", { exact: false })).toBeVisible();

  await page.screenshot({
    path: "test-results/screenshots/hud-desktop.png",
    fullPage: true,
  });
});

test("labels incomplete inventory and minimum counts", async ({ page }) => {
  await serveSnapshot(page, partialSnapshot());
  await page.goto("/");
  await expect(page.getByText("Native inventory is incomplete", { exact: false })).toBeVisible();
  await expect(page.getByText("≥3", { exact: true }).first()).toBeVisible();
});

test("opens audit evidence by keyboard and never links unsafe protocols", async ({ page }) => {
  await serveSnapshot(page);
  await page.goto("/");
  const work = page.locator("article.work").first();
  const workContext = work.locator("details.work-audit");
  const summary = workContext.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(workContext).toHaveAttribute("open", "");
  await expect(
    workContext.getByRole("link", { name: "https://example.com/request-evidence" }),
  ).toHaveAttribute("href", "https://example.com/request-evidence");
  const hostile = workContext.getByText("javascript:alert(document.domain)", { exact: true });
  await expect(hostile).toBeVisible();
  expect(await hostile.evaluate((node) => node.tagName)).toBe("CODE");
  await expect(workContext.locator('a[href^="javascript:"]')).toHaveCount(0);

  const assignmentAudit = work.locator("details.assignment-audit").first();
  await assignmentAudit.locator("summary").click();
  await expect(assignmentAudit.getByText("root-agentvoice", { exact: true })).toBeVisible();
  await expect(assignmentAudit.getByText("turn-thread-research", { exact: true })).toBeVisible();

  const resultAudit = work
    .locator(".result-list > li")
    .filter({ hasText: "Recovered the durable work boundaries" })
    .locator("details.result-audit");
  await resultAudit.locator("summary").click();
  await expect(resultAudit.getByText("wiki:durable-work-owner", { exact: true })).toBeVisible();
  await expect(resultAudit.getByText("None recorded.", { exact: true }).first()).toBeVisible();
});

test("labels a stale observation without hiding durable work", async ({ page }) => {
  await serveSnapshot(page, completeSnapshot("2026-09-13T20:00:00.000Z"), false);
  await page.goto("/");
  await expect(page.getByText("Snapshot stale", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing the last observation", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Make durable work and native execution legible at a glance",
    }),
  ).toBeVisible();
});

test("keeps durable work visible when native observation is unavailable", async ({ page }) => {
  await serveSnapshot(page, unavailableSnapshot());
  await page.goto("/");
  await expect(page.getByText("Native observation unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("execution counts and thread state are unknown", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Make durable work and native execution legible at a glance",
    }),
  ).toBeVisible();
  await expect(page.getByText("Observation unavailable", { exact: true }).first()).toBeVisible();
});

test("retains the last snapshot and identifies a failed refresh", async ({ page }) => {
  let requests = 0;
  const snapshot = completeSnapshot();
  await page.route("**/api/hud", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...snapshot, observedAt: new Date().toISOString() }),
      });
    } else {
      await route.fulfill({ status: 503, body: "unavailable" });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Work ledger" })).toBeVisible();
  await expect(page.getByText("The latest refresh failed", { exact: false })).toBeVisible({
    timeout: 4_000,
  });
  await expect(
    page.getByRole("heading", {
      name: "Make durable work and native execution legible at a glance",
    }),
  ).toBeVisible();
});

test("reflows without horizontal overflow on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveSnapshot(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Native hierarchy" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/screenshots/hud-mobile.png",
    fullPage: true,
  });
});
