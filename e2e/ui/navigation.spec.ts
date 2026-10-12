/// <reference lib="dom" />
import { expect, open, PAGES, resolvePath, settle, showNav, TODO, test } from "./support";

/**
 * C2: from every page, every sidebar link and every breadcrumb link opens its page; browser
 * back returns to the start page and forward reopens the target. `?task=` deep-links a Task.
 */
const samePlace = (a: string, b: string) => {
  const x = new URL(a);
  const y = new URL(b);
  return x.pathname === y.pathname && x.hash === y.hash;
};

for (const start of PAGES.filter((p) => !p.path.includes("#"))) {
  test(`sidebar and breadcrumbs from ${start.name}`, async ({ page, problems }) => {
    test.setTimeout(240_000);
    await open(page, await resolvePath(page, start.path));
    const startUrl = page.url();
    await showNav(page);
    const sidebar = page.locator("#shell-nav nav[aria-label='Main'] a");
    const labels = (await sidebar.allInnerTexts()).map((t) => t.split("\n")[0]?.trim() ?? "");
    // Projects, plus the 13 project pages once a Project is in context.
    expect(labels.length).toBeGreaterThanOrEqual(start.path === "/" ? 1 : 14);

    for (let i = 0; i < labels.length; i++) {
      await showNav(page);
      const link = sidebar.nth(i);
      const href = await link.getAttribute("href");
      expect(href, `sidebar link ${labels[i]} has an href`).toBeTruthy();
      const target = new URL(href as string, page.url()).toString();
      await link.click();
      await page.waitForURL((u) => samePlace(u.toString(), target));
      await settle(page);
      // The current sidebar row is marked.
      await showNav(page);
      await expect(sidebar.nth(i), `${labels[i]} is marked current`).toHaveAttribute(
        "aria-current",
        "page",
      );
      if (samePlace(target, startUrl)) continue;
      await page.goBack();
      await page.waitForURL((u) => samePlace(u.toString(), startUrl));
      await settle(page);
      if (i === 1) {
        await page.goForward();
        await page.waitForURL((u) => samePlace(u.toString(), target));
        await settle(page);
        await page.goBack();
        await page.waitForURL((u) => samePlace(u.toString(), startUrl));
        await settle(page);
      }
    }

    // Breadcrumb links and the Back link go one or more levels up.
    const crumbs = page.locator("nav[aria-label='Breadcrumb'] a");
    const crumbCount = await crumbs.count();
    for (let i = 0; i < crumbCount; i++) {
      const href = await crumbs.nth(i).getAttribute("href");
      const target = new URL(href as string, page.url()).toString();
      await crumbs.nth(i).click();
      await page.waitForURL((u) => samePlace(u.toString(), target));
      await settle(page);
      if (samePlace(target, startUrl)) continue;
      await page.goBack();
      await page.waitForURL((u) => samePlace(u.toString(), startUrl));
      await settle(page);
    }
    const back = page.getByRole("link", { name: /^Back to / });
    if (start.path !== "/") {
      await expect(back).toBeVisible();
      // The Back link goes to a parent page, never to the page it sits on.
      const backHref = new URL((await back.getAttribute("href")) as string, page.url());
      expect(backHref.pathname, "Back link targets the current page").not.toBe(
        new URL(page.url()).pathname,
      );
      await back.click();
      await expect(page).not.toHaveURL(startUrl);
      await settle(page);
    }
    expect.soft(problems.console, "console errors").toEqual([]);
  });
}

test("Work Graph Task node opens the Task on click", async ({ page }) => {
  await open(page, `/changes/${TODO.change}`);
  // The Work Graph card for T1 (XYFlow node), not the Agent activity row.
  const node = page
    .locator(".react-flow__node")
    .getByRole("button", { name: /Bootstrap Worker app/ });
  await node.click({ timeout: 10_000 });
  await expect(page).toHaveURL(new RegExp(`task=${TODO.task}`));
  await expect(page.getByRole("button", { name: "Close Task details" })).toBeVisible();
});

test("Work Graph Task node opens the Task with Enter", async ({ page }) => {
  await open(page, `/changes/${TODO.change}`);
  const node = page
    .locator(".react-flow__node")
    .getByRole("button", { name: /Bootstrap Worker app/ });
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`task=${TODO.task}`));
});

test("Product Graph area node opens the area on click", async ({ page }) => {
  await open(page, `/projects/${TODO.project}/graph`);
  // The first view selects an area without writing it to the URL; a click writes `area=`.
  const target = page.locator(".react-flow__node").getByRole("button").last();
  const name = (await target.getAttribute("aria-label")) ?? "";
  await target.click({ timeout: 10_000 });
  await expect(page).toHaveURL(/[?&]area=/);
  await expect(
    page.locator(".react-flow__node").getByRole("button", { name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Back from the Product Graph goes to the Project overview", async ({ page }) => {
  await open(page, `/projects/${TODO.project}/graph`);
  await page.getByRole("link", { name: /^Back to / }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${TODO.project}$`));
});

test("?task= deep link opens the Task; Close and Back clear it", async ({ page }) => {
  await open(page, `/changes/${TODO.change}`);
  await open(page, `/changes/${TODO.change}?task=${TODO.task}`);
  const close = page.getByRole("button", { name: "Close Task details" });
  await expect(close).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bootstrap Worker app" })).toBeVisible();
  await close.click();
  await expect(page).not.toHaveURL(/task=/);
  await expect(close).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/task=/);
  await expect(close).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/task=/);
  await expect(close).toBeHidden();
});
