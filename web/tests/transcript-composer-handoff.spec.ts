import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

function fixture(messageCount = 1): LiveView {
  return {
    id: "transcript-composer-handoff",
    persistenceScope: `transcript-composer-handoff-${messageCount}`,
    phase: "live",
    voice: [],
    agent: [
      ...Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        status: "complete" as const,
        content: `Message ${index}. ${"Long readable transcript text. ".repeat(12)}`,
      })),
      {
        id: "tool",
        role: "tool",
        status: "complete",
        content: "",
        toolActivity: {
          name: "Command",
          detail: "pwd",
          state: "complete",
          sections: [{ label: "Output", content: "/work" }],
        },
      },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
}

test("printable transcript input appends at the draft end and persists", async ({ page }) => {
  const view = fixture();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Existing draft");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await transcript.focus();
  await transcript.press("x");
  await expect(input).toHaveValue("Existing draftx");
  await expect(input).toBeFocused();
  await page.reload();
  await expect(input).toHaveValue("Existing draftx");

  await input.fill("");
  await transcript.focus();
  await transcript.press("A");
  await expect(input).toHaveValue("A");
  await expect(input).toBeFocused();
});

test("handoff ignores special keys, shortcuts, interactive targets, selection, IME and unavailable input", async ({
  page,
}) => {
  const view = fixture();
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Unchanged");
  await transcript.focus();
  for (const key of ["Enter", "Escape", "ArrowLeft", "F6"]) {
    await transcript.press(key);
    await expect(input).toHaveValue("Unchanged");
  }
  await transcript.dispatchEvent("keydown", { key: "k", ctrlKey: true });
  await transcript.dispatchEvent("keydown", { key: "k", metaKey: true });
  await transcript.dispatchEvent("keydown", { key: "k", altKey: true });
  await expect(input).toHaveValue("Unchanged");

  const disclosure = page.locator(".tool-disclosure__trigger");
  await disclosure.dispatchEvent("keydown", { key: "z" });
  await expect(input).toHaveValue("Unchanged");

  const message = page.getByText(/Message 0\./).first();
  await transcript.focus();
  await message.evaluate((element) => {
    const node = element.firstChild;
    if (!node) throw new Error("Missing text node");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(7, node.textContent?.length ?? 0));
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  });
  await expect(input).toHaveValue("Unchanged");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  await transcript.focus();
  await transcript.dispatchEvent("keydown", { key: "あ", isComposing: true });
  await expect(input).toHaveValue("Unchanged");

  view.agentControls!.available = false;
  await expect(page.locator(".transcript-composer__activity-line")).toHaveAttribute(
    "data-reachable",
    "false",
  );
  await transcript.focus();
  await transcript.press("q");
  await expect(input).toHaveValue("Unchanged");
});

test("mobile transcript input moves into the composer without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const view = fixture();
  view.persistenceScope = "transcript-composer-handoff-mobile";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await transcript.focus();
  await transcript.press("m");
  await expect(input).toHaveValue("m");
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("plain reading keys scroll long history while preserving composer focus and draft", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1000, height: 700 });
  const view = fixture(100);
  view.persistenceScope = "transcript-reading-keys";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(1000);
  await input.fill("Existing draft");
  await input.focus();
  const pageSize = await transcript.evaluate((element) => element.clientHeight);

  await input.press("Home");
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(2);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Existing draft");

  await input.press("PageDown");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(pageSize / 2);
  const pageDown = await transcript.evaluate((element) => element.scrollTop);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Existing draft");

  await input.press("PageUp");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(pageDown - pageSize / 2);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Existing draft");

  await input.press("End");
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Existing draft");

  await transcript.hover();
  await page.mouse.wheel(0, -5000);
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeGreaterThan(1000);
  await input.focus();
  const middle = await transcript.evaluate((element) => element.scrollTop);
  await input.dispatchEvent("keydown", { key: "Home", ctrlKey: true });
  await input.dispatchEvent("keydown", { key: "PageDown", isComposing: true });
  await page.waitForTimeout(50);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(middle);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Existing draft");
});

test("blank transcript clicks and pointer-closed disclosures restore the composer caret", async ({
  page,
}) => {
  const view = fixture();
  view.persistenceScope = "transcript-default-focus";
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
  await input.fill("Existing draft");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  const canvas = transcript.locator(".chat-transcript");
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 8, y: bounds.height - 8 } });
  await expect(input).toBeFocused();
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(
    "Existing draft".length,
  );

  const disclosure = page.locator(".tool-disclosure__trigger");
  await disclosure.click();
  await expect(disclosure).toBeFocused();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(input).toBeFocused();
  await input.press("x");
  await expect(input).toHaveValue("Existing draftx");
});

test("queue removal and attachment removal restore focus without changing draft bytes", async ({
  page,
}) => {
  const view = fixture();
  view.persistenceScope = "transient-operation-focus";
  view.agentControls!.queue = [
    {
      id: "queued",
      text: "Older queued work",
      canSteer: false,
      canResume: false,
      disabled: false,
    },
  ];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    if (route.request().postDataJSON().action === "remove") view.agentControls!.queue = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/clipboard-image", (route) =>
    route.fulfill({ json: { path: "/workspace/.agentvoice-images/focus.png" } }),
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Draft bytes");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Draft bytes");
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(
    "Draft bytes".length,
  );

  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(4)], "focus.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByRole("list", { name: "Attached images" })).toBeVisible();
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await page.getByRole("button", { name: "Remove Image #1" }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Draft bytes");
  expect(await input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart)).toBe(
    "Draft bytes".length,
  );
});

test("send and active-turn steer keep the composer focus", async ({ page }) => {
  const view = fixture();
  view.persistenceScope = "submission-focus";
  const actions: string[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/agent", (route) => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action === "send") view.agentControls!.active = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Idle message");
  await input.press("Enter");
  await expect.poll(() => actions).toEqual(["send"]);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(page.locator(".transcript-composer__activity-line")).toHaveAttribute(
    "data-active",
    "true",
  );

  await input.fill("Steer message");
  await input.press("Enter");
  await expect.poll(() => actions).toEqual(["send", "steer"]);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
});

test("explicit document close returns to the composer after the dialog is gone", async ({
  page,
}) => {
  const view = fixture();
  view.persistenceScope = "document-close-focus";
  view.agent = [
    {
      id: "guide",
      role: "assistant",
      status: "complete",
      content: "[Read the guide](/fixture/guide.md)",
    },
  ];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/document", (route) =>
    route.fulfill({
      json: { title: "Guide", path: "/fixture/guide.md", content: "# Guide\n\nReadable." },
    }),
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true });
  await input.fill("Document draft");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
  await page.getByRole("link", { name: "Read the guide", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Guide", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close document" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press("x");
  await expect(input).toHaveValue("Document draftx");
});
