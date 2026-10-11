/// <reference lib="dom" />
import { evidence, expect, open, TODO, test } from "./support";

/** C3: Project overview on the read-only "Todo check" fixture. */
test.describe("Project overview", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, `/projects/${TODO.project}`);
  });

  test("stat strip, Changes table and canonical source", async ({ page }) => {
    for (const label of ["Generation", "Active changes", "Tasks done", "Verified", "Model calls"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    const changes = page.getByRole("table", { name: "Changes" });
    await expect(changes).toBeVisible();
    await expect(changes.getByRole("link", { name: /Build a simple todo list app/ })).toBeVisible();
    await changes.getByRole("link", { name: /Build a simple todo list app/ }).click();
    await expect(page).toHaveURL(new RegExp(`/changes/${TODO.change}`));
  });

  test("execution timeline: zoom, Fit, Latest, tooltip, legend", async ({ page }, info) => {
    const plot = page.locator("section[aria-label='Execution timeline']");
    await expect(plot).toBeVisible();
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    const fit = page.getByRole("button", { name: "Fit" });
    // Fit is the start: the whole span shows, so Zoom out is disabled and Fit is pressed.
    await expect(fit).toHaveAttribute("aria-pressed", "true");
    await expect(zoomOut).toBeDisabled();
    await expect(page.getByText("Whole timeline shown")).toBeVisible();

    const widthOf = () => plot.evaluate((el) => el.scrollWidth);
    const before = await widthOf();
    await zoomIn.click();
    await zoomIn.click();
    await expect.poll(widthOf).toBeGreaterThan(before);
    await expect(fit).toHaveAttribute("aria-pressed", "false");
    await expect(zoomOut).toBeEnabled();
    await expect(page.getByText(/ \/ 100 px/)).toBeVisible();

    await page.getByRole("button", { name: /^(Latest|Now)$/ }).click();
    await expect
      .poll(() => plot.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 30))
      .toBe(true);

    // Keyboard: 0 fits again.
    await plot.focus();
    await page.keyboard.press("0");
    await expect(fit).toHaveAttribute("aria-pressed", "true");
    await expect.poll(widthOf).toBeLessThanOrEqual(before + 1);

    // Hover a Change marker: the tooltip appears.
    const marker = plot.getByRole("link", { name: /, \d\d:\d\d:\d\d: / }).first();
    await marker.hover();
    const tip = page.locator("div.pointer-events-none.absolute.z-50");
    await expect(tip).toBeVisible();
    expect((await tip.innerText()).trim().length).toBeGreaterThan(3);

    await expect(page.getByRole("list", { name: "Change markers" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Task attempt bars" })).toBeVisible();
    await evidence(page, info, "timeline");
  });

  test("timeline Full screen (native): opens and the button leaves it", async ({ page }) => {
    const full = page.getByRole("button", { name: "Full screen", exact: true });
    const exit = page.getByRole("button", { name: "Exit full screen", exact: true });
    await full.click();
    await expect(exit).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    // Esc in a native full screen is handled by the browser itself, which a synthetic key
    // press cannot reach; the overlay test below covers the app's own Esc handling.
    await exit.click();
    await expect(full).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  });

  test("timeline Full screen (overlay fallback): Esc closes it", async ({ page }) => {
    // Refuse the Fullscreen API so the component uses its fixed overlay.
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("refused"));
    });
    await open(page, `/projects/${TODO.project}`);
    const full = page.getByRole("button", { name: "Full screen", exact: true });
    const exit = page.getByRole("button", { name: "Exit full screen", exact: true });
    await full.click();
    await expect(exit).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(full).toBeVisible();
    await expect(exit).toBeHidden();
    await full.click();
    await exit.click();
    await expect(full).toBeVisible();
  });

  test("Needs attention rail lists only what waits on a person", async ({ page }) => {
    const rail = page.getByRole("complementary", { name: "Needs attention" });
    await expect(rail).toBeVisible();
    const links = rail.getByRole("link");
    if ((await links.count()) === 0) {
      await expect(rail.getByText(/Nothing waits on a person/)).toBeVisible();
    } else {
      const href = await links.first().getAttribute("href");
      await links.first().click();
      await expect(page).toHaveURL(new RegExp(href?.split("#")[0] ?? "/changes/"));
    }
  });

  test("new Change form: default budget pre-filled, inline errors", async ({ page }) => {
    const goal = page.getByRole("textbox", { name: "Goal" });
    const budget = page.getByRole("spinbutton", { name: "Budget (USD)" });
    await expect(goal).toBeVisible();
    // The Project default (Settings, else the built-in default).
    await expect(budget).not.toHaveValue("");
    expect(Number(await budget.inputValue())).toBeGreaterThan(0);
    await expect(page.getByText(/The Project's default/)).toBeVisible();

    await goal.fill("");
    await page.getByRole("button", { name: "Submit change" }).click();
    // Native constraint validation (required, min) must not pre-empt the inline errors.
    const native = await goal.evaluate((el: HTMLTextAreaElement) => el.validationMessage);
    expect.soft(native, "browser validation bubble instead of an inline error").toBe("");
    await expect(page.getByRole("alert")).toHaveText("Describe the goal before you submit.", {
      timeout: 5_000,
    });

    await goal.fill("test goal that is never submitted");
    await budget.fill("0");
    await page.getByRole("button", { name: "Submit change" }).click();
    await expect(page.getByRole("alert")).toHaveText("Set a budget above $0.00.", {
      timeout: 5_000,
    });
    // Nothing was submitted: still on the overview.
    await expect(page).toHaveURL(new RegExp(`/projects/${TODO.project}`));
    // Leave no draft behind.
    await goal.fill("");
    await budget.fill("");
  });
});
