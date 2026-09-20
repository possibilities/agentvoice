import { expect, test } from "@playwright/test";

const content = `Normal prose begins here.

- An unordered entry that wraps naturally on a narrow display.
- Another unordered entry with **emphasis** and ordinary text.
  - A nested bullet keeps its existing inset.

1. An ordered entry with **emphasis** that wraps naturally onto additional lines on a narrow display.

   A continuation paragraph keeps the same hanging text edge.

2. Another ordered entry.
   1. A nested ordered entry with its own hanging text.

Another ordinary prose paragraph.

9. A ninth entry that wraps naturally onto additional lines on a narrow display.
10. A tenth entry shares the same hanging text edge.`;

for (const width of [1440, 390, 320]) {
  test(`ordered markers start at prose while unordered geometry stays unchanged at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/tests/transcript-ui.html");
    await page.locator("main").evaluate((element) => {
      element.style.height = "1000px";
    });
    await page.evaluate((content) => {
      const fixture = (
        window as unknown as {
          transcriptFixture: {
            setMessages(messages: unknown[]): void;
            setFollow(value: boolean): void;
          };
        }
      ).transcriptFixture;
      fixture.setFollow(false);
      fixture.setMessages([{ id: "lists", role: "assistant", status: "complete", content }]);
    }, content);
    await page.evaluate(() => document.fonts.ready);
    const unordered = page.locator(".markdown-content > ul");
    const currentPixels = await unordered.screenshot();
    const currentGeometry = await unordered.evaluate((element) => {
      const origin = element.getBoundingClientRect();
      return [...element.querySelectorAll("li")].map((item) => {
        const rect = item.getBoundingClientRect();
        return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height];
      });
    });
    // Render the pre-change unordered rules on the same content, at the same
    // width, rather than accepting a new visual baseline for bullet lists.
    await unordered.evaluate((element) => {
      for (const list of [element, ...element.querySelectorAll("ul")]) {
        Object.assign((list as HTMLElement).style, {
          paddingLeft: "2ch",
          listStylePosition: "outside",
          listStyleType: "disc",
          marginBlock: "12px",
        });
      }
      for (const item of element.querySelectorAll<HTMLElement>("li")) {
        item.style.marginTop = item.previousElementSibling ? "4px" : "0px";
      }
    });
    expect(await unordered.screenshot()).toEqual(currentPixels);
    expect(
      await unordered.evaluate((element) => {
        const origin = element.getBoundingClientRect();
        return [...element.querySelectorAll("li")].map((item) => {
          const rect = item.getBoundingClientRect();
          return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height];
        });
      }),
    ).toEqual(currentGeometry);
    const ordered = page.locator(".markdown-content ol");
    await expect(ordered).toHaveCount(3);
    await expect(page.locator('ol[start="9"] > li').first()).toHaveAttribute(
      "data-ordered-marker",
      "9.",
    );
    await expect(page.locator('ol[start="9"] > li').last()).toHaveAttribute(
      "data-ordered-marker",
      "10.",
    );
    const geometry = await ordered.evaluateAll((lists) =>
      lists.map((list) => {
        const box = list.getBoundingClientRect();
        const prose = list
          .closest(".markdown-content")!
          .querySelector("p")!
          .getBoundingClientRect();
        return {
          topLevel: list.parentElement?.classList.contains("markdown-content"),
          proseOffset: box.x - prose.x,
          role: list.getAttribute("role"),
          items: [...list.children]
            .filter((element) => element.tagName === "LI")
            .map((item) => {
              const itemBox = item.getBoundingClientRect();
              const marker = getComputedStyle(item, "::before");
              const textEdge = itemBox.x + parseFloat(getComputedStyle(item).paddingLeft);
              const lines = new Map<number, number>();
              const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent?.trim() || node.parentElement?.closest("li") !== item)
                  continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) {
                  if (rect.width > 0)
                    lines.set(rect.y, Math.min(lines.get(rect.y) ?? Infinity, rect.x));
                }
              }
              return {
                markerOffset: itemBox.x + parseFloat(marker.left) - box.x,
                marker: marker.content,
                textOffsets: [...lines.values()].map((left) => left - textEdge),
                lineCount: lines.size,
              };
            }),
        };
      }),
    );
    for (const list of geometry) {
      expect(list.role).toBe("list");
      if (list.topLevel) expect(Math.abs(list.proseOffset)).toBeLessThanOrEqual(1);
      for (const item of list.items) {
        expect(Math.abs(item.markerOffset)).toBeLessThanOrEqual(1);
        expect(item.marker).toMatch(/\d+\./);
        for (const offset of item.textOffsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
      }
    }
    if (width < 640) expect(geometry[0]!.items[0]!.lineCount).toBeGreaterThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/transcript-lists-${width}.png`, fullPage: true });
    await page.locator('ol[start="9"]').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/transcript-lists-${width}-multi-digit.png`,
      fullPage: true,
    });
  });
}
