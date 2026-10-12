/// <reference lib="dom" />
import { expect, open, showNav, test } from "./support";

/**
 * The admin area is for the platform admin only. The smoke user is not one: every admin address
 * shows a plain "Not found", no admin data, and the sidebar has no Admin link.
 */
test.describe("Admin area for a non-admin", () => {
  for (const path of [
    "/admin",
    "/admin/users",
    "/admin/projects",
    "/admin/costs",
    "/admin/events",
    "/admin/access",
  ]) {
    test(`${path} shows Not found`, async ({ page }) => {
      await open(page, path);
      await expect(page.locator("h1")).toHaveText("Not found");
      await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
      await expect(page.getByRole("table")).toHaveCount(0);
      await showNav(page);
      await expect(page.locator("#shell-nav").getByRole("link", { name: "Admin" })).toHaveCount(0);
    });
  }
});
