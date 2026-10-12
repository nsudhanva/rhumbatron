/// <reference lib="dom" />
import { evidence, expect, open, TODO, test } from "./support";

/** C6: the project pages on the read-only "Todo check" fixture. Nothing here writes. */
const P = `/projects/${TODO.project}`;

test("Flight Control: header counts, Compare Candidates link", async ({ page }) => {
  await open(page, `/changes/${TODO.change}/flight`);
  for (const label of ["Woken", "Running", "Done", "Failed", "Candidates", "Cost"]) {
    await expect(page.locator("dt", { hasText: new RegExp(`^${label}$`) }).first()).toBeVisible();
  }
  await page.getByRole("link", { name: "Compare Candidates" }).click();
  await expect(page).toHaveURL(new RegExp(`/compare/${TODO.change}`));
});

test("Product Graph: Project and Change zoom", async ({ page }) => {
  await open(page, `${P}/graph`);
  const zoom = page.getByRole("group", { name: "Zoom" });
  for (const name of ["Project", "Change"]) {
    await zoom.getByRole("button", { name, exact: true }).click();
    await expect(zoom.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".react-flow").first()).toBeVisible();
  }
  await expect(page.getByText(/Areas shown/i)).toBeVisible();
});

test("Agents: List and Graph, filters", async ({ page }, info) => {
  await open(page, `${P}/agents`);
  const view = page.getByRole("group", { name: "Agents view" });
  await view.getByRole("button", { name: "List" }).click();
  await expect(view.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .locator("#content")
      .getByText(/Bootstrap Worker app/)
      .first(),
  ).toBeVisible();
  await view.getByRole("button", { name: "Graph" }).click();
  await expect(view.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
  const time = page.getByRole("combobox", { name: "Time" });
  await expect(time).toBeVisible();
  await time.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  await options.nth(1).click();
  await expect(time).not.toHaveText(/Any time/);
  await evidence(page, info, "agents-graph-filtered");
});

test("Events: List and Graph, type filter, Load older", async ({ page }) => {
  await open(page, `${P}/events`);
  const filters = page.getByRole("group", { name: "Event type" });
  await expect(filters).toBeVisible();
  const planning = filters.getByRole("button", { name: /^Planning/ });
  await planning.click();
  await expect(planning).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: /^All/ }).click();
  await expect(filters.getByRole("button", { name: /^All/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const older = page.getByRole("button", { name: "Load older" });
  if (await older.isVisible()) {
    const before = await page
      .getByText(/\d+ loaded/)
      .first()
      .innerText();
    await older.click();
    await expect(page.getByText(/\d+ loaded/).first()).not.toHaveText(before);
  } else {
    await expect(page.getByText(/Start of the recorded stream/)).toBeVisible();
  }
  const view = page.getByRole("group", { name: "Events view" });
  await view.getByRole("button", { name: "Graph" }).click();
  await expect(view.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
  // The List and the Graph share one filter bar.
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Time" })).toBeVisible();
});

test("Verification, Workspace, Versions, Costs show their data", async ({ page }) => {
  await open(page, `${P}/verification`);
  await expect(page.getByText(/Required checks met/i).first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Recent Candidates" })).toBeVisible();

  await open(page, `${P}/workspace`);
  await expect(page.getByText(/Canonical generation/i).first()).toBeVisible();
  await expect(
    page.getByText(/cand-dc31a659317dac824aa25e23|cand_dc31a659317dac824aa25e23/).first(),
  ).toBeVisible();

  await open(page, `${P}/versions`);
  const versions = page.getByRole("table", { name: "Versions" });
  await expect(versions.getByRole("link", { name: /^S1 Live/ })).toBeVisible();
  await expect(versions.getByRole("button", { name: "Roll back to S0" })).toBeVisible();

  await open(page, `${P}/costs`);
  await expect(page.getByText(/Model calls today/i).first()).toBeVisible();
  await expect(
    page
      .locator("#content")
      .getByText(/\$\d+\.\d\d/)
      .first(),
  ).toBeVisible();
});

test("Code: browse a file, Edit opens CodeMirror, Cancel leaves it", async ({ page }) => {
  await open(page, `${P}/code`);
  // File tree rows meet the 24px target size.
  const rowHeight = await page
    .getByRole("button", { name: /app\.ts/ })
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThanOrEqual(24);
  await page
    .getByRole("button", { name: /app\.ts/ })
    .first()
    .click();
  await expect(
    page
      .locator("#content")
      .getByText(/createApp|Hono/)
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(0);
});

test("Settings: sections, members, every input named", async ({ page }) => {
  await open(page, `${P}/settings`);
  for (const label of ["General", "People", "Defaults"]) {
    await expect(page.getByRole("heading", { name: label, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Todo check");
  await expect(
    page.locator("#content").getByText("smoke+prod@rhumbatron.com").first(),
  ).toBeVisible();
  // Members sits under the People h2.
  await expect(page.getByRole("heading", { name: "Members", level: 3 })).toBeVisible();
  // Every input on the page has an accessible name (Kumo warns about a nameless Input here).
  const nameless = await page.evaluate(() =>
    [...document.querySelectorAll("#content input, #content textarea")]
      .filter((el) => {
        const input = el as HTMLInputElement;
        if (input.type === "hidden") return false;
        const labelled =
          input.labels?.length ||
          input.getAttribute("aria-label") ||
          input.getAttribute("aria-labelledby");
        return !labelled;
      })
      .map((el) => el.outerHTML.slice(0, 160)),
  );
  expect.soft(nameless, "inputs without an accessible name").toEqual([]);
});
