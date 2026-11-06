import { expect, test } from "@playwright/test";

/**
 * The plain user path through the web UI: a blank Project, one instruction, a live app that
 * works. It creates and keeps one Project (one model-built Change, a few cents of model spend).
 */

const GOAL = [
  "Build a tip calculator web app on the home page.",
  'It has a number input labeled "Bill amount" and a number input labeled "Tip percent" with the default value 15.',
  'Below the inputs it shows "Tip: $X.XX" and "Total: $Y.YY" with two decimals, and both update as the person types.',
].join(" ");

test("@desktop-only a blank Project becomes a working live app", async ({
  page,
  context,
}, info) => {
  test.setTimeout(25 * 60_000);
  const stamp = Date.now().toString(36);

  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(`Tip calculator ${stamp}`);
  await page.getByRole("textbox", { name: "Slug" }).fill(`tips-${stamp}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/proj_[0-9a-f-]+$/, { timeout: 60_000 });
  const projectUrl = page.url();

  await page.getByRole("textbox", { name: "Goal" }).fill(GOAL);
  await page.getByRole("button", { name: "Submit change" }).click();
  await page.waitForURL(/\/changes\/chg_/, { timeout: 60_000 });
  const changeUrl = page.url();
  console.log(`change: ${changeUrl}`);

  // The Project page says "Not live yet" until the first release, then links the app. A host
  // can also answer "Nothing built yet" before the build lands. Wait for the built app.
  const app = await context.newPage();
  const deadline = Date.now() + 20 * 60_000;
  let appUrl: string | null = null;
  let title = "";
  while (Date.now() < deadline) {
    if (!appUrl) {
      await page.goto(projectUrl);
      const open = page.getByRole("link", { name: "Open app" }).first();
      if (await open.isVisible({ timeout: 5_000 }).catch(() => false)) {
        appUrl = await open.getAttribute("href");
        console.log(`app: ${appUrl}`);
      }
    }
    if (appUrl) {
      const response = await app.goto(appUrl);
      title = await app.title();
      if (response?.status() === 200 && title !== "Nothing built yet") break;
    }
    await page.waitForTimeout(15_000);
  }
  expect(appUrl, "the Project page links its live app").toBeTruthy();
  console.log(`app title: ${title}`);
  expect(title, "the app host serves the built app").not.toBe("Nothing built yet");
  await page.screenshot({ path: info.outputPath("project.png"), fullPage: true });
  await page.goto(changeUrl);
  await page.screenshot({ path: info.outputPath("change.png"), fullPage: true });

  await app.getByLabel(/Bill amount/i).fill("100");
  await app.getByLabel(/Tip percent/i).fill("20");
  await expect(app.locator("body")).toContainText("Tip: $20.00");
  await expect(app.locator("body")).toContainText("Total: $120.00");
  await app.screenshot({ path: info.outputPath("app.png"), fullPage: true });
});
