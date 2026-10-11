/// <reference lib="dom" />
import { evidence, expect, open, TODO, test } from "./support";

/** C7: the notifications popover opens, lists items in groups, and closes. Nothing is marked read. */
test("notifications popover opens and closes", async ({ page }, info) => {
  await open(page, "/");
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  const name = (await bell.getAttribute("aria-label")) ?? "";
  await bell.click();
  const close = page.getByRole("button", { name: "Close notifications" });
  await expect(close).toBeVisible();
  await expect(page.getByText("Notifications", { exact: true }).last()).toBeVisible();
  if (/unread/.test(name)) {
    await expect(page.getByRole("button", { name: "Mark all read" })).toBeVisible();
  }
  const empty = page.getByText("Nothing needs you.");
  if (!(await empty.isVisible())) {
    // Each item is a link to what it is about.
    const items = page.locator("[role='dialog'] a[href]");
    expect(await items.count()).toBeGreaterThan(0);
  }
  await evidence(page, info, "notifications");
  await close.click();
  await expect(close).toBeHidden();
  await bell.click();
  await expect(close).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(close).toBeHidden();
  await expect(bell).toBeFocused();
});

/** C8: the live app of the built "Todo check" Project serves its page and its API. Read-only. */
test("live app host serves the page and its API", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const response = await page.goto(TODO.app);
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toContainText(/todo/i);
  const health = await request.get(`${TODO.app}/api/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });
  const todos = await request.get(`${TODO.app}/api/todos`);
  expect(todos.status()).toBe(200);
  expect(todos.headers()["content-type"]).toMatch(/json/);
  expect(errors).toEqual([]);
});
