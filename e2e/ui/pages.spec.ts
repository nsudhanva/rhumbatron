/// <reference lib="dom" />
import {
  disabledWithoutReason,
  evidence,
  expect,
  horizontalOverflow,
  isNarrow,
  open,
  PAGES,
  resolvePath,
  test,
} from "./support";

/**
 * C9: every page loads with content in light and dark mode, logs no console error, has no
 * disabled control without a reason, and at 412px has no horizontal scroll.
 */
for (const mode of ["light", "dark"] as const) {
  test.describe(`${mode} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem("rh-mode", m), mode);
    });

    for (const { name, path: template } of PAGES) {
      test(`${name} loads clean`, async ({ page, problems }, info) => {
        const path = await resolvePath(page, template);
        await open(page, path);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
        await expect(page.locator("h1")).toHaveCount(1);
        // "<Page> · <Project or Change> · Rhumbatron"; the notification count may lead.
        await expect
          .poll(async () => (await page.title()).replace(/^\(\d+\+?\) /, ""))
          .toMatch(path === "/" ? /^Projects · Rhumbatron$/ : /^[^·]+ · .+ · Rhumbatron$/);
        const text = (await page.locator("#content").innerText()).trim();
        expect(text.length, "page has content").toBeGreaterThan(80);

        // The ground follows the mode : light #f3f2f2, dark #141312.
        const ground = await page.evaluate(() => {
          const el = document.getElementById("content") ?? document.body;
          let node: HTMLElement | null = el;
          while (node) {
            const bg = getComputedStyle(node).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)") return bg;
            node = node.parentElement;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        });
        expect(ground).toBe(mode === "light" ? "rgb(243, 242, 242)" : "rgb(20, 19, 18)");

        const disabled = await disabledWithoutReason(page);
        expect.soft(disabled, "disabled controls without a reason").toEqual([]);

        if (isNarrow(page)) {
          const overflow = await horizontalOverflow(page);
          expect.soft(overflow, "horizontal scroll at 412px").toEqual({ document: 0, content: 0 });
        }
        expect.soft(problems.console, "console errors").toEqual([]);
        expect.soft(problems.network, "failed requests").toEqual([]);
        if (info.errors.length > 0) await evidence(page, info, "page");
      });
    }
  });
}

test("sign-in page loads for a signed-out visitor", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/sign-in");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("textbox").first()).toBeVisible({ timeout: 30_000 });
  expect.soft(errors).toEqual([]);
  await context.close();
});
