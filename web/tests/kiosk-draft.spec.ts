import { expect, test } from "@playwright/test";

const view = {
  id: "kiosk-fixture-view",
  persistenceScope: "kiosk-fixture-workspace-thread",
  phase: "live",
  voice: [],
  agent: [],
  agentControls: { available: true, active: false, stopping: false, pending: false, queue: [] },
};

// Browser contexts provide isolated storage; the native harness separately verifies
// actual WKWebView process termination and defaultDataStore persistence.
test("native instance restores the main draft after session storage is lost, while another window remains isolated", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL });
  await first.addInitScript(() => {
    Object.defineProperty(window, "funkKiosk", {
      value: Object.freeze({ persistenceInstanceId: "fixture.kiosk:main" }),
    });
  });
  const page = await first.newPage();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Draft across native process identity");
  const state = await first.storageState();
  await first.close();

  const reopened = await browser.newContext({ baseURL, storageState: state });
  await reopened.addInitScript(() => {
    Object.defineProperty(window, "funkKiosk", {
      value: Object.freeze({ persistenceInstanceId: "fixture.kiosk:main" }),
    });
  });
  const next = await reopened.newPage();
  await next.route("**/api/live", (route) => route.fulfill({ json: view }));
  await next.goto("/");
  await expect(next.getByRole("textbox", { name: "Message Agent" })).toHaveValue(
    "Draft across native process identity",
  );
  await reopened.close();

  const another = await browser.newContext({ baseURL, storageState: state });
  await another.addInitScript(() => {
    Object.defineProperty(window, "funkKiosk", {
      value: Object.freeze({ persistenceInstanceId: "fixture.kiosk:other-window" }),
    });
  });
  const other = await another.newPage();
  await other.route("**/api/live", (route) => route.fulfill({ json: view }));
  await other.goto("/");
  await expect(other.getByRole("textbox", { name: "Message Agent" })).toHaveValue("");
  await another.close();
});
