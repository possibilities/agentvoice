import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

test("typing, selection and composition survive streaming history and control updates", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let revision = 0;
  const view: LiveView = {
    phase: "live",
    persistenceScope: "composer-stream.spec.ts-workspace-thread",
    id: "streaming-input",
    voice: [],
    agent: [],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  const history = Array.from({ length: 180 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    status: "complete" as const,
    content: `Reply ${index}\n\nReview **the implementation** and preserve its behavior.\n\n- Existing input remains available.\n- History can continue updating.\n\n\`value = ${index}\``,
  }));
  await page.route("**/api/live", (route) => {
    revision++;
    view.agent = [
      ...history,
      {
        id: "stream",
        role: "assistant",
        status: "streaming",
        content: `Streaming revision ${revision}`,
      },
    ];
    view.voice = [
      {
        id: "voice-stream",
        role: "assistant",
        status: "streaming",
        content: `Speaking revision ${revision}`,
      },
    ];
    return route.fulfill({ json: view });
  });
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/agent", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  // Count the input owner renders in the development module without shipping
  // profiling hooks. The command function belongs to that interaction boundary.
  await page.route("**/src/App.tsx", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source).toContain("const agentCommand = async");
    await route.fulfill({
      response,
      body: source.replace(
        "const agentCommand = async",
        'performance.mark("input-owner-render"); const agentCommand = async',
      ),
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await expect(input).toBeVisible();
  await input.evaluate((el) => {
    (window as unknown as { originalInput: Element }).originalInput = el;
  });
  const continuousInput = async () => {
    expect(
      await input.evaluate(
        (el) => el === (window as unknown as { originalInput: Element }).originalInput,
      ),
    ).toBe(true);
    await expect(input).toBeFocused();
  };
  const renderCount = () =>
    page.evaluate(() => performance.getEntriesByName("input-owner-render").length);
  const renders = await renderCount();
  const idleRevision = revision;
  await expect.poll(() => revision).toBeGreaterThan(idleRevision + 2);
  expect(await renderCount()).toBe(renders);
  await input.click();
  const draft = "Keep this draft intact while both conversations update. ".repeat(2);
  const started = revision;
  await input.pressSequentially(draft, { delay: 35 });
  await expect(input).toHaveValue(draft);
  expect(revision - started).toBeGreaterThanOrEqual(3);
  await continuousInput();
  await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 15, "backward"));
  const selectionRevision = revision;
  view.agentControls!.active = true;
  await expect.poll(() => revision).toBeGreaterThan(selectionRevision + 1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await continuousInput();
  expect(
    await input.evaluate((el) => {
      const field = el as HTMLTextAreaElement;
      return [field.selectionStart, field.selectionEnd, field.selectionDirection];
    }),
  ).toEqual([5, 15, "backward"]);
  await page.keyboard.insertText("replacement");
  await expect(input).toHaveValue(`${draft.slice(0, 5)}replacement${draft.slice(15)}`);
  // Exercise the browser event contract without claiming a platform IME session.
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await page.keyboard.insertText("日本語");
  const composingRevision = revision;
  await expect.poll(() => revision).toBeGreaterThan(composingRevision);
  await continuousInput();
  expect(commands).toHaveLength(0);
  await input.dispatchEvent("compositionend", { data: "日本語" });
  const finalDraft = await input.inputValue();
  await input.press("Enter");
  await expect(input).toHaveValue("");
  expect(commands[0]).toMatchObject({
    action: "steer",
    text: finalDraft.trim(),
    viewId: "streaming-input",
  });
  await page.screenshot({ path: "test-results/composer-streaming.png", fullPage: true });
});
