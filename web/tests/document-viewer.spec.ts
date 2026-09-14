import { expect, test } from "@playwright/test";
import type { LiveView } from "../src/types.ts";

const guide = `# A readable project guide

The document stays inside the conversation, with room to read and an easy way back.

## Clear structure

| State | Meaning |
| --- | --- |
| Ready | The native session is available |
| Detached | Voice is disconnected; text still works |

\`\`\`typescript
const document = { readable: true, private: true };
\`\`\`

[Continue to the next document](next.md)

[External reference](https://example.com/reference)
`;

test("document links render in the host, navigate relative documents, and preserve the draft", async ({
  page,
}) => {
  const view: LiveView = {
    id: "document-fixture-view",
    persistenceScope: "document-fixture-scope",
    phase: "live",
    voice: [],
    agent: [
      {
        id: "guide-link",
        role: "assistant",
        status: "complete",
        content: "[Read the guide](/fixture/docs/guide.md:12)",
      },
    ],
    agentControls: { available: true, active: false, pending: false, stopping: false, queue: [] },
  };
  const requests: unknown[] = [];
  await page.route("**/api/live", (route) => route.fulfill({ json: view }));
  await page.route("**/api/document", (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    return route.fulfill({
      json:
        request.href === "next.md"
          ? {
              title: "Next document",
              path: "/fixture/docs/next.md",
              content: "# Next document\n\nRelative navigation works.",
            }
          : { title: "A readable project guide", path: "/fixture/docs/guide.md", content: guide },
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Draft stays while reading");
  const trigger = page.getByRole("link", { name: "Read the guide", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "A readable project guide", level: 1 }),
  ).toBeVisible();
  await expect(dialog.getByRole("table")).toContainText("Voice is disconnected");
  await expect(dialog.locator("pre")).toContainText("readable: true");
  await expect(dialog.getByRole("link", { name: "External reference" })).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );
  await page.screenshot({ path: "test-results/document-viewer-wide.png", fullPage: true });
  await dialog.getByRole("link", { name: "Continue to the next document" }).click();
  await expect(dialog).toContainText("Relative navigation works.");
  expect(requests[1]).toEqual({ href: "next.md", base: "/fixture/docs/guide.md" });
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.locator("pre")).toContainText("readable: true");
  await page.setViewportSize({ width: 600, height: 900 });
  await page.screenshot({ path: "test-results/document-viewer-narrow.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue("Draft stays while reading");
  await expect(trigger).toBeFocused();
});

test("document failure is visible and retry works without losing entry text", async ({ page }) => {
  let failed = true;
  await page.route("**/api/live", (route) =>
    route.fulfill({
      json: {
        id: "document-error",
        persistenceScope: "document-error-scope",
        phase: "live",
        voice: [],
        agent: [
          {
            id: "link",
            role: "assistant",
            status: "complete",
            content: "[Open note](/fixture/note.md)",
          },
        ],
        agentControls: {
          available: true,
          active: false,
          pending: false,
          stopping: false,
          queue: [],
        },
      },
    }),
  );
  await page.route("**/api/document", (route) =>
    route.fulfill(
      failed
        ? {
            status: 403,
            json: { error: "This document is not available in the current conversation." },
          }
        : {
            json: {
              title: "Recovered note",
              path: "/fixture/note.md",
              content: "# Recovered note\n\nReady to read.",
            },
          },
    ),
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Agent" });
  await input.fill("Keep my next message");
  await page.getByRole("link", { name: "Open note" }).click();
  await expect(page.getByRole("alert")).toContainText("not available");
  failed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Ready to read.");
  await page.getByRole("button", { name: "Close document" }).click();
  await expect(input).toHaveValue("Keep my next message");
});
